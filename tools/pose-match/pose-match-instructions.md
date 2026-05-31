# LLM Instructions: Video Pose Extraction & Webcam Matching

## Remaining work
- Add variable "choose song" when playing
- merge with frontend


## Goal
Extract body keypoints from a reference dance video and compare them in real-time against a webcam feed using MediaPipe Pose. Output a per-frame similarity score.

---

## Prerequisites to verify before writing any code

1. Confirm `mediapipe` version — API changed significantly at 0.10.x. Use `mp.solutions.pose` for <0.10, `mediapipe.tasks` for >=0.10. Check with `import mediapipe; print(mediapipe.__version__)`.
2. Confirm `yt-dlp` is installed and the video URL is accessible.
3. Confirm webcam index (usually 0; may be 1+ on multi-camera machines).
4. The reference video must have a **single, front-facing dancer** in frame. Warn the user if the video has multiple dancers or frequent camera cuts.

---

## Step 1 — Download the reference video

```bash
pip install yt-dlp mediapipe opencv-python numpy --break-system-packages
yt-dlp -f "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]" \
       -o "reference.mp4" "<VIDEO_URL>"
```

Verify the file exists and is non-zero bytes before proceeding.

---

## Step 2 — Extract reference poses

Write `extract_poses.py`. Rules:
- Open `reference.mp4` with `cv2.VideoCapture`.
- Run `mp.solutions.pose.Pose(model_complexity=2, min_detection_confidence=0.5)` on every frame.
- For each frame, store a list of 33 landmarks: `[x, y, z, visibility]`. If no landmarks detected, store `null`.
- Also store `fps` and total `frame_count` from the capture.
- Write output to `assets/dances/references/<name>-poses.json`: `{ "fps": float, "frame_count": int, "frames": [...] }`.

Run it. Print progress every 100 frames. Confirm output file size > 0.

---

## Step 3 — Define normalization and similarity (shared module `pose_utils.py`)

### Normalization
Purpose: make poses invariant to the person's distance from camera and height in frame.

```
hip_center    = mean of landmarks[23] and landmarks[24]  (x,y,z only)
shoulder_mid  = mean of landmarks[11] and landmarks[12]
torso_scale   = L2 norm of (shoulder_mid - hip_center)

normalized[i] = (landmark[i].xyz - hip_center) / torso_scale
```

If `torso_scale < 0.01` (person not visible / too close), return `None`.

### Similarity score
- Compare only the **key joints**: `[11,12,13,14,15,16,23,24,25,26,27,28]`
  (shoulders, elbows, wrists, hips, knees, ankles).
- For each key joint, skip it if `visibility < 0.5` in **either** reference or live frame.
- For qualifying joints, compute **cosine similarity** between the normalized (x,y) 2-vectors. Do not use z — MediaPipe's depth estimate is unreliable from a single camera.
- Final score = mean of per-joint cosine similarities, mapped to `[0, 1]`.
- If fewer than 4 joints qualify, return `None` (not enough data).

---

## Step 4 — Real-time webcam comparison (`run.py`)

Logic:

```
load reference_poses.json
open webcam (cv2.VideoCapture(0))
record wall-clock start time T0

loop:
    read webcam frame
    compute elapsed = time.time() - T0
    ref_frame_idx = int(elapsed * reference_fps)  # sync by wall clock
    if ref_frame_idx >= frame_count: break or loop

    run MediaPipe Pose on webcam frame
    normalize webcam pose
    normalize reference_poses[ref_frame_idx]
    score = similarity(ref, live)

    draw on webcam frame:
        - reference keypoints (blue)
        - live keypoints (green)
        - score as large text top-left ("Score: 0.82")
        - current ref frame index

    cv2.imshow("Pose Match", frame)
    if cv2.waitKey(1) == ord('q'): break
```

Start playback with a 3-second countdown so the user can get in position.

---

## Step 5 — Optional: skeleton overlay helper

Draw the standard MediaPipe Pose connections using `mp.solutions.drawing_utils.draw_landmarks`. Use different colors for reference (blue, semi-transparent) vs. live (green, solid). Blend reference skeleton onto the live frame at 40% opacity using `cv2.addWeighted`.

---

## Invariants — never violate

1. **Normalize before comparing** — raw pixel coords are meaningless across different distances.
2. **Use wall-clock time for sync**, not frame counters. Webcam frame rate may differ from reference video FPS.
3. **Skip low-visibility joints** — a missing wrist shouldn't tank the score.
4. **Don't use z for similarity** — use it only optionally for 3D visualization.
5. **Reference poses are precomputed** — never re-run MediaPipe on the reference video during the live loop.

---

## Known failure modes to handle

| Failure | Fix |
|---|---|
| MediaPipe detects no pose in reference frame | Store `null`, skip that frame in scoring |
| Webcam not found | Print clear error with `cv2.VideoCapture` index tried |
| Reference video has multiple dancers | Warn user; scoring will be noisy |
| Torso not visible (person too far/close) | Return `None` score, display "Move into frame" |
| Audio/video desync | Wall-clock sync handles this; don't try to sync to audio beats unless explicitly asked |

---

## Deliverables

- `extract_poses.py` — offline, run once per reference video
- `pose_utils.py` — normalize + similarity functions with unit tests
- `run.py` — live webcam comparison loop
- `reference_poses.json` — precomputed reference data (generated, not hand-written)

## Done-when

- A person roughly matching the reference dance scores >0.75
- A person standing still scores <0.4
- Swapping arms/legs (mirrored pose) scores noticeably lower than the correct pose
