"""Extract ChoreographyContour from a video file using MediaPipe Tasks API.

Usage:
    python extract_choreo_from_video.py \
        --video ../../assets/dances/ra-ra-rasuputin.webm \
        --song-id rasputin \
        --start 50 --duration 60

Output: ../../assets/songs/<song_id>/choreography.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL_PATH = REPO_ROOT / "tools" / "pose-match" / "pose_landmarker_full.task"

EXPORT_LANDMARKS = {
    "nose", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
}

LANDMARK_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer",
    "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky",
    "left_index", "right_index", "left_thumb", "right_thumb",
    "left_hip", "right_hip", "left_knee", "right_knee",
    "left_ankle", "right_ankle", "left_heel", "right_heel",
    "left_foot_index", "right_foot_index",
]


def extract(video_path: Path, song_id: str, start_sec: float, duration: float, output: Path, target_fps: int = 30) -> None:
    if not MODEL_PATH.exists():
        print(f"Model not found: {MODEL_PATH}", file=sys.stderr)
        sys.exit(1)

    options = mp_vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp_vision.RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    landmarker = mp_vision.PoseLandmarker.create_from_options(options)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"Cannot open: {video_path}", file=sys.stderr)
        sys.exit(1)

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    start_frame = int(start_sec * video_fps)
    end_frame = int((start_sec + duration) * video_fps)
    frame_step = max(1, round(video_fps / target_fps))

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

    frames: list[dict] = []
    frame_idx = start_frame
    processed = 0

    print(f"Extracting {duration:.0f}s starting at {start_sec:.0f}s  ({end_frame - start_frame} source frames, step={frame_step})")

    while frame_idx <= end_frame:
        ok, bgr = cap.read()
        if not ok:
            break

        if (frame_idx - start_frame) % frame_step == 0:
            small = cv2.resize(bgr, (640, 360))
            rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect(mp_image)

            t = round((frame_idx - start_frame) / video_fps, 4)
            if result.pose_landmarks:
                lms = result.pose_landmarks[0]
                kps = {}
                for i, lm in enumerate(lms):
                    name = LANDMARK_NAMES[i]
                    if name in EXPORT_LANDMARKS:
                        kps[name] = {
                            "x": round(lm.x, 5),
                            "y": round(lm.y, 5),
                            "z": round(lm.z, 5),
                            "visibility": round(lm.visibility, 4),
                        }
                frames.append({"t": t, "keypoints": kps})
            else:
                frames.append({"t": t, "keypoints": {}})

            processed += 1
            if processed % 30 == 0:
                print(f"  {t:.1f}s / {duration:.0f}s  ({processed} frames)", end="\r")

        frame_idx += 1

    cap.release()
    landmarker.close()

    output.parent.mkdir(parents=True, exist_ok=True)
    contour = {"song_id": song_id, "fps": target_fps, "frames": frames}
    output.write_text(json.dumps(contour, separators=(",", ":")))
    print(f"\nSaved {len(frames)} frames → {output}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--video", required=True, type=Path)
    p.add_argument("--song-id", required=True)
    p.add_argument("--start", type=float, default=0.0)
    p.add_argument("--duration", type=float, default=60.0)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--output", type=Path, default=None)
    args = p.parse_args()

    output = args.output or (REPO_ROOT / "assets" / "songs" / args.song_id / "choreography.json")
    extract(args.video, args.song_id, args.start, args.duration, output, args.fps)


if __name__ == "__main__":
    main()
