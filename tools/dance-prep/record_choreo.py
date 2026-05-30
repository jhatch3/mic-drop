"""Offline dance choreography recorder.

Records a reference dancer via webcam using MediaPipe Pose and exports
choreography.json for a song asset.

Usage:
    python record_choreo.py --song-id <song_id> [--fps 30] [--duration 60]
                            [--output ../../assets/songs/<song_id>/choreography.json]
                            [--camera 0]

The script shows a live preview window. Press SPACE to start/stop recording,
Q or ESC to quit. Only the segment between the two SPACE presses is saved.

Output format matches contracts/dance.ts ChoreographyContour:
{
  "song_id": "...",
  "fps": 30,
  "frames": [
    { "t": 0.0, "keypoints": { "left_shoulder": {"x":..,"y":..,"z":..,"visibility":..}, ... } },
    ...
  ]
}

Requirements (install in a venv):
    pip install mediapipe opencv-python
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import cv2
    import mediapipe as mp
except ImportError:
    print(
        "Missing dependencies. Install with:\n"
        "  pip install mediapipe opencv-python",
        file=sys.stderr,
    )
    sys.exit(1)

# MediaPipe landmark names in order (index → name)
_LANDMARK_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer",
    "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear",
    "mouth_left", "mouth_right",
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_pinky", "right_pinky",
    "left_index", "right_index",
    "left_thumb", "right_thumb",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
    "left_heel", "right_heel",
    "left_foot_index", "right_foot_index",
]

# Only export these landmarks to keep the JSON compact
_EXPORT_LANDMARKS = {
    "nose", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
}


def _landmarks_to_dict(landmarks) -> dict[str, dict]:
    result = {}
    for i, lm in enumerate(landmarks.landmark):
        name = _LANDMARK_NAMES[i]
        if name in _EXPORT_LANDMARKS:
            result[name] = {
                "x": round(lm.x, 6),
                "y": round(lm.y, 6),
                "z": round(lm.z, 6),
                "visibility": round(lm.visibility, 4),
            }
    return result


def record(song_id: str, target_fps: int, duration: float | None, camera: int, output: Path) -> None:
    mp_pose = mp.solutions.pose
    mp_draw = mp.solutions.drawing_utils
    mp_styles = mp.solutions.drawing_styles

    cap = cv2.VideoCapture(camera)
    if not cap.isOpened():
        print(f"Cannot open camera {camera}", file=sys.stderr)
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FPS, target_fps)

    print("=== Dance Choreography Recorder ===")
    print(f"Song:   {song_id}")
    print(f"Target: {target_fps} fps")
    print(f"Output: {output}")
    print()
    print("Controls:")
    print("  SPACE  — start / stop recording")
    print("  Q/ESC  — quit (saves if recording was started)")
    print()

    frames: list[dict] = []
    recording = False
    start_t: float | None = None
    frame_interval = 1.0 / target_fps
    next_capture = 0.0

    with mp_pose.Pose(
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("Camera read failed.", file=sys.stderr)
                break

            now = time.monotonic()

            # Process pose
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            result = pose.process(rgb)
            rgb.flags.writeable = True
            vis = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

            # Draw skeleton
            if result.pose_landmarks:
                mp_draw.draw_landmarks(
                    vis,
                    result.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS,
                    landmark_drawing_spec=mp_styles.get_default_pose_landmarks_style(),
                )

            # Status overlay
            if recording:
                elapsed = now - start_t  # type: ignore[operator]
                label = f"REC {elapsed:.1f}s — {len(frames)} frames  (SPACE=stop)"
                cv2.putText(vis, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                cv2.rectangle(vis, (5, 5), (20, 20), (0, 0, 255), -1)  # red dot
                if duration and elapsed >= duration:
                    print(f"Duration limit reached ({duration}s). Stopping.")
                    recording = False
            else:
                cv2.putText(vis, "SPACE=start recording  Q=quit", (10, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

            cv2.imshow("Dance Prep — Choreography Recorder", vis)

            # Capture frame at target fps
            if recording and now >= next_capture and result.pose_landmarks:
                t = now - start_t  # type: ignore[operator]
                kps = _landmarks_to_dict(result.pose_landmarks)
                frames.append({"t": round(t, 4), "keypoints": kps})
                next_capture = now + frame_interval

            key = cv2.waitKey(1) & 0xFF
            if key == ord(" "):
                if not recording:
                    recording = True
                    start_t = time.monotonic()
                    next_capture = start_t
                    frames.clear()
                    print("Recording started...")
                else:
                    recording = False
                    print(f"Recording stopped. {len(frames)} frames captured.")
            elif key in (ord("q"), ord("Q"), 27):  # Q or ESC
                break

    cap.release()
    cv2.destroyAllWindows()

    if not frames:
        print("No frames captured. Nothing saved.")
        return

    output.parent.mkdir(parents=True, exist_ok=True)
    contour = {"song_id": song_id, "fps": target_fps, "frames": frames}
    output.write_text(json.dumps(contour, indent=2))
    print(f"\nSaved {len(frames)} frames to {output}")
    print(f"Duration: {frames[-1]['t']:.2f}s at ~{len(frames)/frames[-1]['t']:.1f} fps")


def main() -> None:
    parser = argparse.ArgumentParser(description="Record reference choreography for a dance song.")
    parser.add_argument("--song-id", required=True, help="Song ID (used as song_id in output)")
    parser.add_argument("--fps", type=int, default=30, help="Target capture frame rate (default: 30)")
    parser.add_argument("--duration", type=float, default=None, help="Auto-stop after N seconds")
    parser.add_argument("--camera", type=int, default=0, help="Camera device index (default: 0)")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output path (default: ../../assets/songs/<song_id>/choreography.json)",
    )
    args = parser.parse_args()

    output = args.output or (
        Path(__file__).parent.parent.parent
        / "assets" / "songs" / args.song_id / "choreography.json"
    )

    record(
        song_id=args.song_id,
        target_fps=args.fps,
        duration=args.duration,
        camera=args.camera,
        output=output,
    )


if __name__ == "__main__":
    main()
