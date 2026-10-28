# Chaukhat 🏛️

**Chaukhat** is a minimalist, serverless backend pipeline that takes a smartphone video (or a `.zip` archive of photos) of an indoor space and automatically reconstructs a **3D Gaussian Splat model (`model.ply`)**.

Built natively for [Modal](https://modal.com) using **Nerfstudio (`splatfacto`)**, **COLMAP**, and **FFmpeg**.

---

## Architecture Overview

```
Smartphone Video / Photos (.mp4 / .mov / .zip)
                      │
                      ▼
         POST /upload (FastAPI on Modal)
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
    Modal Volume              Modal Dict
  (Persistent Disk)          (Job Status)
          │                       │
          └───────────┬───────────┘
                      ▼
        process_job.spawn(job_id) (GPU Worker: L4 / A10G)
                      │
       1. FFmpeg Frame Extraction (~2 fps, max dimension 1600px)
       2. COLMAP Camera Pose Estimation (ns-process-data sequential)
       3. Nerfstudio Splatfacto Training (15,000 iters, headless)
       4. Gaussian Splat Export (ns-export gaussian-splat)
       5. Save model.ply to Volume at /results/<job_id>/model.ply
                      │
                      ▼
    GET /result/{job_id} -> Download model.ply
```

- **Cloud Infrastructure**: [Modal](https://modal.com) (Serverless containers + GPU execution).
- **Core 3D Engine**: Nerfstudio official image (`ghcr.io/nerfstudio-project/nerfstudio:latest`).
- **Pose Estimation**: COLMAP via `ns-process-data images --matching-method sequential`.
- **Training Method**: `splatfacto` capped at 15,000 iterations without viewer (`--vis none`).
- **Storage**: Persistent `modal.Volume` (named `chaukhat-data`).
- **Job State**: Distributed `modal.Dict` (named `chaukhat-jobs`).

---

## Repository Structure

```
Chaukhat/
├── app.py                  # Modal application with FastAPI endpoints & GPU pipeline
├── frontend/               # Interactive Web Studio
│   ├── index.html          # Camera recording, file drag-and-drop, stepper progress UI
│   ├── styles.css          # Glassmorphic dark theme and responsive layout
│   └── app.js              # MediaRecorder, burst capture, auto-zip & polling logic
├── test_client.py          # Local CLI client to upload, poll, and download model.ply
├── requirements.txt        # Local dependencies
├── .gitignore              # Ignores outputs/, virtualenvs, caches, .env
├── README.md               # Setup, deployment, and troubleshooting guide
└── tests/
    └── sample_data/
        └── README.md       # Capture instructions and sample data guide
```

---

## Prerequisites

1. **Python 3.10+** installed locally.
2. A **Modal account** ([modal.com](https://modal.com)). Modal provides free monthly compute credits suitable for running test jobs.

---

## Setup Instructions

### 1. Create and Activate a Local Virtual Environment

```bash
# Navigate to the project root
cd /Users/vrutimoradiya/Documents/Github/Chaukhat

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate
```

### 2. Install Dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

### 3. Authenticate with Modal

Run the following command to link your local terminal to your Modal account:

```bash
modal setup
```
*(This opens a browser window where you can approve terminal access).*

---

## Deployment & Running

### Option A: Development Mode (Hot-reloading & ephemeral URL)

If you are actively testing code changes or want temporary logs streamed directly into your terminal:

```bash
modal serve app.py
```

Modal will print a development URL, for example:
```
✓ Created web function api => https://your-workspace--chaukhat-api-dev.modal.run
```

---

### Option B: Production Deployment (Permanent Serverless Endpoint)

To deploy the API as a permanent cloud service:

```bash
modal deploy app.py
```

Modal will build container images (caching them for future runs) and print your permanent endpoint URL:
```
✓ Deployed app 'chaukhat'
✓ Created web function api => https://your-workspace--chaukhat-api.modal.run
```

Save this URL for running the test client or connecting other systems.

---

## Using the Web Studio (Browser Interface)

When you run `modal serve app.py` or `modal deploy app.py`, open the printed URL directly in your browser (e.g. `https://your-workspace--chaukhat-api.modal.run`).

The Web Studio includes:
1. **📸 Live Camera Capture**:
   - **Video Recording**: Click "Start Camera", switch between front/back smartphone cameras, record a smooth room walk-through, preview it, and submit with one click.
   - **Auto Burst Scan**: Automatically snaps high-resolution photos every 1.5s as you walk through the room, then bundles them into an in-memory `.zip` ready for processing.
2. **📁 Drag-and-Drop File Upload**:
   - Drop videos (`.mp4`, `.mov`, `.webm`) or `.zip` archives.
   - **Multi-Photo Auto-Zip**: Select or drop multiple photos at once; the browser automatically archives them into `photos.zip` with a progress bar!
3. **⚙️ Iteration Controls**:
   - Choose between **5k Draft** (~2 min preview), **15k Standard** (~6 mins), or **30k Ultra** (~12 mins).
4. **📊 Live 6-Stage Progress Stepper**:
   - Visual progress bar and live counters for extracted frames, registered poses, and terminal logs.
5. **✨ 1-Click 3D Download & Viewers**:
   - Download the resulting `model.ply` and launch directly into PlayCanvas SuperSplat or Antimatter15 WebGL viewers.

---

## Running the Test Client

Prepare a video (e.g. 15–30 seconds of an indoor room) or a `.zip` archive containing photos.

Place your video in `tests/sample_data/my_room.mp4`, then run:

```bash
python test_client.py tests/sample_data/my_room.mp4 --url https://<YOUR_WORKSPACE>--chaukhat-api.modal.run
```

### What Happens:
1. **Uploads** the file to `POST /upload`.
2. **Receives `job_id`** (e.g., `4a7b9c1d2e3f`).
3. **Polls `GET /status/{job_id}`** every 10 seconds:
   - `queued`
   - `extracting_frames`
   - `estimating_poses`
   - `training`
   - `exporting`
   - `done`
4. **Downloads `model.ply`** into `./outputs/model.ply` and `./outputs/model_<job_id>.ply`.

---

## API Reference

### 1. `POST /upload`
- **Description**: Accepts a video or zip file, creates `job_id`, spawns GPU processing in background, returns immediately.
- **Request**: `multipart/form-data` with field `file` (`.mp4`, `.mov`, `.m4v`, or `.zip`).
- **Optional Query Params**: `iterations` (default: 15000).
- **Response**:
  ```json
  {
    "job_id": "4a7b9c1d2e3f",
    "status": "queued",
    "filename": "my_room.mp4",
    "message": "Job successfully queued for 3D Gaussian Splat processing"
  }
  ```

### 2. `GET /status/{job_id}`
- **Description**: Returns current lifecycle stage and progress details.
- **Response**:
  ```json
  {
    "job_id": "4a7b9c1d2e3f",
    "status": "training",
    "filename": "my_room.mp4",
    "created_at": "2026-10-28T10:00:00Z",
    "updated_at": "2026-10-28T10:02:15Z",
    "error": null,
    "details": {
      "extracted_frames_count": 48,
      "registered_frames_count": 44,
      "max_iterations": 15000
    }
  }
  ```

### 3. `GET /result/{job_id}`
- **Description**: Downloads the reconstructed 3D Gaussian Splat `model.ply` file.
- **Status Codes**:
  - `200 OK`: File stream (`application/octet-stream`).
  - `409 Conflict`: If job is still in progress.
  - `400 Bad Request`: If job failed (returns error message).
  - `404 Not Found`: If job_id does not exist.

---

## Viewing the 3D Gaussian Splat

The exported `model.ply` can be visualized immediately in any standard Gaussian Splat viewer:
- **PlayCanvas SuperSplat**: [playcanvas.com/supersplat/editor](https://playcanvas.com/supersplat/editor) (drag and drop `.ply`)
- **Antimatter15 WebGL Viewer**: [antimatter15.com/splat](https://antimatter15.com/splat/)
- **Nerfstudio Viser**: `ns-viewer --load-config ...`

---

## Troubleshooting & Common Errors

| Error | Cause | Resolution |
|---|---|---|
| `"COLMAP failed to register enough images: Video too shaky or too little overlap, re-capture slower"` | Camera was moved too quickly, motion blur was too high, or camera turned too fast without overlap. | Re-record the video moving at a slow, steady walking pace with 70–80% visual overlap between angles. Ensure the room has adequate lighting. |
| `"Unsupported file format"` | Uploaded file was not `.mp4`, `.mov`, `.m4v`, or `.zip`. | Convert video to `.mp4` or package images into a `.zip` archive. |
| `"Job failed: CUDA out of memory"` | GPU ran out of VRAM due to exceptionally high resolution or dense points. | The pipeline automatically downscales frames to max 1600px. If needed, switch GPU type in `app.py` from `L4` to `A10G` or `A100`. |
| `modal.exception.AuthError` | Terminal is not logged in to Modal. | Run `modal setup` to re-authenticate. |
