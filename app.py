"""Chaukhat: Backend pipeline for Smartphone Video / Photo -> 3D Gaussian Splatting (.ply).

Powered by Modal, Nerfstudio (splatfacto), COLMAP, and FFmpeg.
"""

import json
import logging
import os
import shutil
import subprocess
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import modal

# ------------------------------------------------------------------------------
# Logging Configuration
# ------------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [chaukhat] %(message)s",
)
logger = logging.getLogger("chaukhat")

# ------------------------------------------------------------------------------
# Modal Infrastructure Definitions
# ------------------------------------------------------------------------------
APP_NAME = "chaukhat"
app = modal.App(APP_NAME)

# Persistent cloud storage for inputs and generated 3D splats
volume = modal.Volume.from_name("chaukhat-data", create_if_missing=True)

# Persistent distributed dictionary for tracking job lifecycle
job_dict = modal.Dict.from_name("chaukhat-jobs", create_if_missing=True)

# Path where the volume is mounted inside container environments
STORAGE_MOUNT = "/vol"
UPLOADS_DIR = Path(STORAGE_MOUNT) / "uploads"
RESULTS_DIR = Path(STORAGE_MOUNT) / "results"
FRONTEND_DIR = Path(__file__).parent / "frontend"

# ------------------------------------------------------------------------------
# Container Images
# ------------------------------------------------------------------------------
# 1. Slim CPU image for FastAPI web endpoints (instant cold start)
web_image = (
    modal.Image.debian_slim()
    .pip_install(
        "fastapi==0.111.0",
        "python-multipart==0.0.9",
    )
    .add_local_dir(str(FRONTEND_DIR), remote_path="/assets")
)

# 2. Heavy GPU container with Nerfstudio, PyTorch, CUDA, COLMAP, and FFmpeg
nerfstudio_image = (
    modal.Image.from_registry(
        "ghcr.io/nerfstudio-project/nerfstudio:latest",
        add_python="3.10",
    )
    .apt_install("ffmpeg")
)

# ------------------------------------------------------------------------------
# Helper Functions
# ------------------------------------------------------------------------------
def update_job_status(
    job_id: str,
    stage: str,
    error: Optional[str] = None,
    extra: Optional[dict] = None,
) -> None:
    """Updates the distributed job status dict."""
    record = job_dict.get(job_id, {"job_id": job_id})
    record["status"] = stage
    record["updated_at"] = datetime.now(timezone.utc).isoformat()
    if error:
        record["error"] = error
    if extra:
        details = record.setdefault("details", {})
        details.update(extra)
    job_dict[job_id] = record
    logger.info(f"Job [{job_id}] status updated to: {stage} (error={error is not None})")


def ensure_symlinks() -> None:
    """Ensures /results points to /vol/results for standard path compatibility."""
    try:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        if not os.path.exists("/results"):
            os.symlink(str(RESULTS_DIR), "/results")
    except Exception as e:
        logger.debug(f"Symlink /results note: {e}")


# ------------------------------------------------------------------------------
# GPU Pipeline Function
# ------------------------------------------------------------------------------
GPU_TYPE = os.environ.get("CHAUKHAT_GPU_TYPE", "L4")  # "L4" or "A10G"

@app.function(
    image=nerfstudio_image,
    gpu=GPU_TYPE,
    timeout=3600,  # 1 hour maximum execution
    volumes={STORAGE_MOUNT: volume},
)
def process_job(job_id: str, max_iterations: int = 15000):
    """Executes the complete 3D Gaussian Splatting reconstruction pipeline."""
    ensure_symlinks()
    logger.info(f"Starting process_job for job_id={job_id} on GPU={GPU_TYPE}")

    # Use fast container-local NVMe scratch disk for heavy I/O (COLMAP + training)
    work_dir = Path(f"/tmp/chaukhat_run_{job_id}")
    work_dir.mkdir(parents=True, exist_ok=True)

    raw_images_dir = work_dir / "raw_images"
    raw_images_dir.mkdir(parents=True, exist_ok=True)

    colmap_dir = work_dir / "colmap_processed"
    train_output_dir = work_dir / "nerfstudio_outputs"
    export_dir = work_dir / "exported_splat"

    try:
        # Step 0: Fetch uploaded file from the persistent Volume
        volume.reload()
        upload_job_dir = UPLOADS_DIR / job_id
        if not upload_job_dir.exists():
            raise FileNotFoundError(f"Upload directory for job {job_id} not found in volume")

        uploaded_files = list(upload_job_dir.glob("*"))
        if not uploaded_files:
            raise FileNotFoundError(f"No input file found for job {job_id}")

        input_path = uploaded_files[0]
        ext = input_path.suffix.lower()
        logger.info(f"[{job_id}] Processing input: {input_path.name} ({input_path.stat().st_size} bytes)")

        # ----------------------------------------------------------------------
        # Stage 1: extracting_frames
        # ----------------------------------------------------------------------
        update_job_status(job_id, "extracting_frames")

        is_video = ext in {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
        is_zip = ext in {".zip"}

        if not (is_video or is_zip):
            raise ValueError(f"Unsupported file type '{ext}'. Supported: .mp4, .mov, .webm, .zip")

        if is_video:
            # Extract ~2 frames per second, scaled so longer side <= 1600px, no upscaling
            # Using conditional scale filter with aspect ratio preservation
            vf_filter = (
                r"fps=2,"
                r"scale=if(gte(iw\,ih)\,min(1600\,iw)\,-2):if(lt(iw\,ih)\,min(1600\,ih)\,-2)"
            )
            ffmpeg_cmd = [
                "ffmpeg",
                "-y",
                "-i", str(input_path),
                "-vf", vf_filter,
                "-q:v", "2",
                str(raw_images_dir / "frame_%05d.jpg"),
            ]
            logger.info(f"[{job_id}] Running FFmpeg: {' '.join(ffmpeg_cmd)}")
            res = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
            if res.returncode != 0:
                logger.error(f"FFmpeg error: {res.stderr}")
                raise RuntimeError(f"FFmpeg frame extraction failed: {res.stderr[-300:]}")

        elif is_zip:
            logger.info(f"[{job_id}] Unpacking zip file...")
            with zipfile.ZipFile(input_path, "r") as zf:
                zf.extractall(work_dir / "unzipped")

            # Collect and flatten valid images
            valid_exts = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"}
            extracted_images = [
                p for p in (work_dir / "unzipped").rglob("*")
                if p.is_file() and p.suffix.lower() in valid_exts and not p.name.startswith(".")
            ]
            if not extracted_images:
                raise ValueError("Zip archive did not contain any valid image files (.jpg, .png, etc.)")

            for idx, img_p in enumerate(sorted(extracted_images)):
                dest = raw_images_dir / f"frame_{idx:05d}{img_p.suffix.lower()}"
                shutil.copy2(img_p, dest)

        # Verify extracted frame count
        extracted_frames = sorted(list(raw_images_dir.glob("frame_*")))
        num_frames = len(extracted_frames)
        logger.info(f"[{job_id}] Total frames ready for COLMAP: {num_frames}")

        if num_frames < 5:
            raise RuntimeError(
                f"Too few images extracted ({num_frames} frames). Ensure the video is at least 3-5 seconds long."
            )

        update_job_status(job_id, "extracting_frames", extra={"extracted_frames_count": num_frames})

        # ----------------------------------------------------------------------
        # Stage 2: estimating_poses (COLMAP via ns-process-data)
        # ----------------------------------------------------------------------
        update_job_status(job_id, "estimating_poses")

        # Use sequential matching as specified for video / consecutive indoor captures
        colmap_cmd = [
            "ns-process-data",
            "images",
            "--data", str(raw_images_dir),
            "--output-dir", str(colmap_dir),
            "--matching-method", "sequential",
            "--verbose",
        ]
        logger.info(f"[{job_id}] Running COLMAP: {' '.join(colmap_cmd)}")
        colmap_res = subprocess.run(colmap_cmd, capture_output=True, text=True)

        transforms_file = colmap_dir / "transforms.json"
        registered_frames = 0
        if transforms_file.exists():
            try:
                with open(transforms_file, "r") as f:
                    tf_data = json.load(f)
                    registered_frames = len(tf_data.get("frames", []))
            except Exception as e:
                logger.warning(f"Failed to parse transforms.json: {e}")

        logger.info(f"[{job_id}] COLMAP completed. Registered frames: {registered_frames}/{num_frames}")

        # Check for COLMAP failures or insufficient camera poses
        min_required_frames = max(5, int(num_frames * 0.25))
        if colmap_res.returncode != 0 or not transforms_file.exists() or registered_frames < min_required_frames:
            error_msg = (
                f"COLMAP failed to register enough images (registered {registered_frames}/{num_frames} frames). "
                "Video too shaky or too little overlap, re-capture slower."
            )
            logger.error(f"[{job_id}] {error_msg}")
            if colmap_res.stderr:
                logger.error(f"COLMAP stderr: {colmap_res.stderr[-500:]}")
            update_job_status(job_id, "failed", error=error_msg)
            return

        update_job_status(job_id, "estimating_poses", extra={"registered_frames_count": registered_frames})

        # ----------------------------------------------------------------------
        # Stage 3: training (splatfacto, headless)
        # ----------------------------------------------------------------------
        update_job_status(job_id, "training", extra={"max_iterations": max_iterations})

        train_cmd = [
            "ns-train",
            "splatfacto",
            "--vis", "none",
            "--max-num-iterations", str(max_iterations),
            "--output-dir", str(train_output_dir),
            "nerfstudio-data",
            "--data", str(colmap_dir),
        ]
        logger.info(f"[{job_id}] Starting splatfacto training: {' '.join(train_cmd)}")
        train_res = subprocess.run(train_cmd, capture_output=True, text=True)

        # Locate config.yml generated by nerfstudio
        config_files = list(train_output_dir.rglob("config.yml"))
        if train_res.returncode != 0 or not config_files:
            error_details = train_res.stderr[-500:] if train_res.stderr else "Training aborted"
            raise RuntimeError(f"Nerfstudio splatfacto training failed: {error_details}")

        # Pick the most recently created config.yml
        config_path = sorted(config_files, key=os.path.getmtime)[-1]
        logger.info(f"[{job_id}] Training completed. Config located at: {config_path}")

        # ----------------------------------------------------------------------
        # Stage 4: exporting (gaussian-splat to .ply)
        # ----------------------------------------------------------------------
        update_job_status(job_id, "exporting")
        export_dir.mkdir(parents=True, exist_ok=True)

        export_cmd = [
            "ns-export",
            "gaussian-splat",
            "--load-config", str(config_path),
            "--output-dir", str(export_dir),
        ]
        logger.info(f"[{job_id}] Exporting gaussian splat: {' '.join(export_cmd)}")
        export_res = subprocess.run(export_cmd, capture_output=True, text=True)

        exported_plys = list(export_dir.glob("*.ply"))
        if export_res.returncode != 0 or not exported_plys:
            error_details = export_res.stderr[-500:] if export_res.stderr else "Export aborted"
            raise RuntimeError(f"ns-export gaussian-splat failed: {error_details}")

        ply_source = exported_plys[0]
        ply_size_bytes = ply_source.stat().st_size
        logger.info(f"[{job_id}] Exported PLY: {ply_source.name} ({ply_size_bytes / (1024*1024):.2f} MB)")

        # ----------------------------------------------------------------------
        # Stage 5: Save to persistent Modal Volume at /results/<job_id>/model.ply
        # ----------------------------------------------------------------------
        job_result_dir = RESULTS_DIR / job_id
        job_result_dir.mkdir(parents=True, exist_ok=True)
        final_ply_path = job_result_dir / "model.ply"

        shutil.copy2(ply_source, final_ply_path)
        logger.info(f"[{job_id}] Copied model to Volume at {final_ply_path}")

        # Commit volume changes so API endpoints and other containers see the file
        volume.commit()

        # ----------------------------------------------------------------------
        # Stage 6: done
        # ----------------------------------------------------------------------
        update_job_status(
            job_id,
            "done",
            extra={
                "result_path": f"/results/{job_id}/model.ply",
                "file_size_bytes": ply_size_bytes,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        logger.info(f"[{job_id}] Processing finished successfully.")

    except Exception as exc:
        logger.exception(f"[{job_id}] Unhandled pipeline failure: {exc}")
        update_job_status(job_id, "failed", error=str(exc))
    finally:
        # Clean up local scratch workspace on container
        if work_dir.exists():
            shutil.rmtree(work_dir, ignore_errors=True)


# ------------------------------------------------------------------------------
# FastAPI Application & Endpoints
# ------------------------------------------------------------------------------
web_app = FastAPI(
    title="Chaukhat 3D Gaussian Splatting API",
    description="Serverless indoor 3D Gaussian Splatting reconstruction pipeline",
    version="1.0.0",
)

# Enable CORS for browser-based UI and external client access
web_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@web_app.get("/", tags=["UI"])
def serve_ui():
    """Serves the Chaukhat web interface."""
    assets_index = Path("/assets/index.html")
    local_index = FRONTEND_DIR / "index.html"
    if assets_index.exists():
        return FileResponse(assets_index)
    elif local_index.exists():
        return FileResponse(local_index)
    return {
        "service": "chaukhat",
        "description": "3D Gaussian Splatting backend pipeline on Modal",
        "endpoints": {
            "upload": "POST /upload",
            "status": "GET /status/{job_id}",
            "result": "GET /result/{job_id}",
        },
    }


@web_app.get("/api/health", tags=["Health"])
def health_check():
    """Health check endpoint for service liveness."""
    return {"status": "ok", "service": "chaukhat"}


# Serve static assets directly for relative root resolution
@web_app.get("/styles.css", include_in_schema=False)
def serve_css():
    p = Path("/assets/styles.css") if Path("/assets/styles.css").exists() else FRONTEND_DIR / "styles.css"
    return FileResponse(p, media_type="text/css")


@web_app.get("/app.js", include_in_schema=False)
def serve_js():
    p = Path("/assets/app.js") if Path("/assets/app.js").exists() else FRONTEND_DIR / "app.js"
    return FileResponse(p, media_type="application/javascript")


# Mount static files directory for frontend assets
static_source = Path("/assets") if Path("/assets").exists() else FRONTEND_DIR
if static_source.exists():
    web_app.mount("/static", StaticFiles(directory=str(static_source)), name="static")


@web_app.post("/upload", tags=["Pipeline"])
async def upload_file(
    file: UploadFile = File(..., description="Smartphone video (.mp4, .mov, .webm) or .zip of photos"),
    iterations: int = 15000,
):
    """Accepts video or zip of photos, saves to Volume, starts background job, returns job_id."""
    filename = file.filename or "upload.webm"
    ext = Path(filename).suffix.lower()
    allowed_exts = {".mp4", ".mov", ".m4v", ".zip", ".webm"}

    if ext not in allowed_exts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file format '{ext}'. Allowed: {', '.join(sorted(allowed_exts))}",
        )

    job_id = uuid.uuid4().hex[:12]
    job_upload_dir = UPLOADS_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)
    target_path = job_upload_dir / filename

    logger.info(f"Receiving upload for new job [{job_id}]: {filename}")

    # Stream file to Volume in chunks
    try:
        with open(target_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024 * 4):  # 4MB chunks
                buffer.write(chunk)
    except Exception as e:
        logger.error(f"Failed to save upload for {job_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not persist upload: {e}",
        )

    # Commit volume so GPU worker sees the uploaded file
    volume.commit()

    # Initialize job state
    job_dict[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "filename": filename,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
        "details": {"max_iterations": iterations},
    }

    # Spawn background GPU task
    process_job.spawn(job_id, iterations)
    logger.info(f"Job [{job_id}] queued and GPU task spawned.")

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": filename,
        "message": "Job successfully queued for 3D Gaussian Splat processing",
    }


@web_app.get("/status/{job_id}", tags=["Pipeline"])
def get_status(job_id: str):
    """Returns the current job lifecycle status and metadata."""
    data = job_dict.get(job_id)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job '{job_id}' not found",
        )
    return data


@web_app.get("/result/{job_id}", tags=["Pipeline"])
def get_result(job_id: str):
    """Returns the completed model.ply file for the given job_id."""
    data = job_dict.get(job_id)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Job '{job_id}' not found",
        )

    job_status = data.get("status")
    if job_status == "failed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Job failed: {data.get('error', 'Unknown failure')}",
        )

    if job_status != "done":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Job is currently in stage '{job_status}'. Result not ready yet.",
        )

    # Sync volume from storage
    volume.reload()
    result_path = RESULTS_DIR / job_id / "model.ply"

    if not result_path.exists():
        logger.error(f"Result file missing for completed job [{job_id}] at {result_path}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Result file not found on volume",
        )

    return FileResponse(
        path=str(result_path),
        media_type="application/octet-stream",
        filename=f"chaukhat_{job_id}_model.ply",
    )


# ------------------------------------------------------------------------------
# ASGI Entrypoint for Modal Web Serving
# ------------------------------------------------------------------------------
@app.function(
    image=web_image,
    volumes={STORAGE_MOUNT: volume},
)
@modal.asgi_app()
def api():
    """Exposes FastAPI app through Modal serverless ASGI endpoint."""
    ensure_symlinks()
    return web_app
