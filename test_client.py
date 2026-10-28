#!/usr/bin/env python3
"""Chaukhat CLI Test Client.

Uploads a smartphone video or zip of photos to the Chaukhat Modal backend,
polls the job status every 10 seconds, and downloads the resulting 3D Gaussian Splat model.ply.

Usage:
    python test_client.py path/to/video.mp4 --url https://<workspace>--chaukhat-api.modal.run
"""

import argparse
import os
import sys
import time
from datetime import datetime
from pathlib import Path
import requests


def log(msg: str) -> None:
    now = datetime.now().strftime("%H:%M:%S")
    print(f"[{now}] {msg}", flush=True)


def upload_capture(base_url: str, file_path: Path, iterations: int) -> str:
    """Uploads capture file to the backend and returns the assigned job_id."""
    upload_url = f"{base_url.rstrip('/')}/upload"
    log(f"Uploading '{file_path.name}' ({file_path.stat().st_size / (1024*1024):.2f} MB) to {upload_url}...")

    with open(file_path, "rb") as f:
        files = {"file": (file_path.name, f)}
        params = {"iterations": iterations}
        response = requests.post(upload_url, files=files, params=params, timeout=120)

    if response.status_code != 200:
        log(f"Upload failed [HTTP {response.status_code}]: {response.text}")
        sys.exit(1)

    data = response.json()
    job_id = data.get("job_id")
    if not job_id:
        log(f"No job_id returned in response: {data}")
        sys.exit(1)

    log(f"Job successfully created with ID: {job_id}")
    return job_id


def poll_status(base_url: str, job_id: str, poll_interval: int = 10) -> dict:
    """Polls /status/{job_id} until the job completes or fails."""
    status_url = f"{base_url.rstrip('/')}/status/{job_id}"
    log(f"Polling job status every {poll_interval}s from {status_url}...")

    last_status = None
    start_time = time.time()

    while True:
        try:
            res = requests.get(status_url, timeout=30)
            if res.status_code != 200:
                log(f"Status check returned HTTP {res.status_code}: {res.text}")
            else:
                data = res.json()
                current_status = data.get("status")
                details = data.get("details", {})
                elapsed = int(time.time() - start_time)

                # Format human-readable details
                extra_info = []
                if "extracted_frames_count" in details:
                    extra_info.append(f"frames={details['extracted_frames_count']}")
                if "registered_frames_count" in details:
                    extra_info.append(f"registered={details['registered_frames_count']}")
                if "max_iterations" in details:
                    extra_info.append(f"max_iter={details['max_iterations']}")

                info_str = f" ({', '.join(extra_info)})" if extra_info else ""

                if current_status != last_status:
                    log(f"-> Status transition: [{current_status.upper()}]{info_str} (elapsed: {elapsed}s)")
                    last_status = current_status
                else:
                    log(f"   Still in [{current_status}]{info_str}... ({elapsed}s elapsed)")

                if current_status == "done":
                    log(f"Job completed successfully in {elapsed} seconds!")
                    return data
                elif current_status == "failed":
                    error_msg = data.get("error", "No error details provided.")
                    log(f"Job FAILED: {error_msg}")
                    sys.exit(1)

        except requests.exceptions.RequestException as e:
            log(f"Network error during poll: {e}")

        time.sleep(poll_interval)


def download_model(base_url: str, job_id: str, output_dir: Path) -> Path:
    """Downloads model.ply from /result/{job_id} into the output directory."""
    result_url = f"{base_url.rstrip('/')}/result/{job_id}"
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / "model.ply"
    timestamped_dest = output_dir / f"model_{job_id}.ply"

    log(f"Downloading 3D Gaussian Splat from {result_url}...")
    with requests.get(result_url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(destination, "wb") as f, open(timestamped_dest, "wb") as f_ts:
            for chunk in r.iter_content(chunk_size=1024 * 1024 * 2):  # 2MB chunks
                if chunk:
                    f.write(chunk)
                    f_ts.write(chunk)

    file_size_mb = destination.stat().st_size / (1024 * 1024)
    log(f"Downloaded model successfully!")
    log(f"Saved to: {destination.resolve()} ({file_size_mb:.2f} MB)")
    log(f"Timestamped copy: {timestamped_dest.resolve()}")
    return destination


def main():
    parser = argparse.ArgumentParser(
        description="Chaukhat 3D Gaussian Splatting client: Upload video/photos and download 3D splat.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "file",
        type=str,
        help="Path to smartphone video (.mp4, .mov) or zip archive of photos (.zip)",
    )
    parser.add_argument(
        "--url",
        "-u",
        type=str,
        default=os.environ.get("CHAUKHAT_API_URL"),
        help="Base URL of deployed Modal app (or set CHAUKHAT_API_URL env var)",
    )
    parser.add_argument(
        "--iterations",
        "-i",
        type=int,
        default=15000,
        help="Number of splatfacto training iterations",
    )
    parser.add_argument(
        "--poll-interval",
        "-p",
        type=int,
        default=10,
        help="Polling interval in seconds",
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        type=str,
        default="./outputs",
        help="Directory to save downloaded model.ply",
    )

    args = parser.parse_args()

    # Validate file
    file_path = Path(args.file)
    if not file_path.exists():
        log(f"Error: File not found at '{file_path}'")
        sys.exit(1)

    valid_exts = {".mp4", ".mov", ".m4v", ".zip"}
    if file_path.suffix.lower() not in valid_exts:
        log(f"Error: Unsupported file format '{file_path.suffix}'. Must be one of {valid_exts}")
        sys.exit(1)

    # Validate URL
    if not args.url:
        log("Error: Backend URL is required. Pass via --url or export CHAUKHAT_API_URL=<url>")
        sys.exit(1)

    base_url = args.url.strip()
    log(f"Connecting to Chaukhat service at: {base_url}")

    # Pipeline execution
    job_id = upload_capture(base_url, file_path, args.iterations)
    poll_status(base_url, job_id, args.poll_interval)
    download_model(base_url, job_id, Path(args.output_dir))
    log("Pipeline complete! You can open ./outputs/model.ply in any 3D Gaussian Splat viewer.")


if __name__ == "__main__":
    main()
