"""extract_poses.py — offline pose extraction from a reference video.

Run once per reference video. Outputs reference_poses.json with all 33
MediaPipe landmarks per frame (or null for frames where no pose is detected).

Usage:
    python extract_poses.py [--video reference.mp4] [--output reference_poses.json]

mediapipe >= 0.10 Tasks API. Model file: pose_landmarker_full.task (same dir).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2

MODEL_PATH = Path(__file__).parent / "pose_landmarker_full.task"


def extract(video_path: Path, output_path: Path) -> None:
    if not video_path.exists():
        print(f"ERROR: video not found: {video_path}", file=sys.stderr)
        sys.exit(1)
    if not MODEL_PATH.exists():
        print(f"ERROR: model not found: {MODEL_PATH}", file=sys.stderr)
        print("Download it with:", file=sys.stderr)
        print("  curl -L -o pose_landmarker_full.task \\", file=sys.stderr)
        print("    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task'", file=sys.stderr)
        sys.exit(1)

    import mediapipe as mp
    from mediapipe.tasks.python import vision as mp_vision
    from mediapipe.tasks.python.core import base_options as mp_base

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"ERROR: cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {video_path.name}  |  {fps:.2f} fps  |  {total} frames  |  {total/fps:.1f}s")

    # Warn if video might have multiple dancers / frequent cuts (heuristic: very wide aspect)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if w > 2 * h:
        print("WARNING: very wide aspect ratio — video may have multiple dancers or split-screen.")
        print("         Scoring will be noisy if the reference dancer isn't centred.")

    opts = mp_vision.PoseLandmarkerOptions(
        base_options=mp_base.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    frames_out: list[list[dict] | None] = []
    frame_idx = 0
    detected = 0

    with mp_vision.PoseLandmarker.create_from_options(opts) as landmarker:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break

            # MediaPipe tasks needs an RGB MpImage
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            timestamp_ms = int(frame_idx * 1000 / fps)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if result.pose_landmarks:
                lms = result.pose_landmarks[0]
                frames_out.append([
                    {"x": lm.x, "y": lm.y, "z": lm.z, "visibility": lm.visibility}
                    for lm in lms
                ])
                detected += 1
            else:
                frames_out.append(None)

            frame_idx += 1
            if frame_idx % 100 == 0:
                pct = 100 * frame_idx / max(total, 1)
                print(f"  {frame_idx}/{total} frames processed ({pct:.0f}%)  detected: {detected}", end="\r")

    cap.release()
    print(f"\nDone. {frame_idx} frames total, {detected} with pose detected ({100*detected/max(frame_idx,1):.1f}%)")

    output = {"fps": fps, "frame_count": frame_idx, "frames": frames_out}
    output_path.write_text(json.dumps(output))
    size_kb = output_path.stat().st_size / 1024
    print(f"Saved: {output_path}  ({size_kb:.0f} KB)")
    if size_kb == 0:
        print("ERROR: output file is empty!", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract MediaPipe Pose landmarks from a reference video.")
    parser.add_argument("--video", type=Path, default=Path("reference.mp4"))
    parser.add_argument("--output", type=Path, default=Path("reference_poses.json"))
    args = parser.parse_args()
    extract(args.video, args.output)


if __name__ == "__main__":
    main()
