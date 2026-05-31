# Dance Gamemode — Build Log

## What Was Built

A "Just Dance"-style second gamemode added to Pitch Battle. Two players take turns
dancing in front of a webcam; their movements are scored against a precomputed reference
choreography. The higher score wins the same Solana-wager pot as karaoke mode.

---

## Architecture

```
Laptop browser
  ├── getUserMedia({ video: true })           webcam capture
  ├── @mediapipe/tasks-vision PoseLandmarker  pose inference, ~30 fps, in-tab
  ├── PoseOverlay canvas                      blue ghost reference + green live skeleton
  └── POST /api/dance/score                   uploads all captured frames at round end

Backend (FastAPI)
  └── /api/dance/score                        authoritative joint-angle scoring
  └── /api/match/finish?gamemode=dance        same finish flow, skips audio

Phones (no change)
  └── same Socket.IO session, same staking UI
```

Key decisions:
- **Webcam → browser directly.** No Raspberry Pi needed for capture. MediaPipe Pose
  runs entirely in-tab via WebAssembly + GPU delegate.
- **Same escrow flow.** Players stake SOL on their phones, winner gets the pot.
  `EscrowClient.settle()` is called identically to karaoke.
- **No audio.** Phones never see video or audio (`getUserMedia` audio:false).

---

## New Files

### Contracts
| File | Purpose |
|------|---------|
| `contracts/dance.ts` | Shared TS types: `PoseFrame`, `ChoreographyContour`, `DanceScore`, joint weights, `HIT_ANGLE_DEG`, `ALIGN_FRAMES` |

### Backend (`backend/dance/`)
| File | Purpose |
|------|---------|
| `scorer.py` | Authoritative scoring: joint angles, ±3-frame alignment, hit threshold |
| `router.py` | `POST /api/dance/score` — loads `choreography.json`, calls scorer |
| `__init__.py` | Package marker |

### Frontend (`frontend/src/dance/`)
| File | Purpose |
|------|---------|
| `types.ts` | Mirror of `contracts/dance.ts` for browser use |
| `usePoseDetection.ts` | Hook: initialises PoseLandmarker, runs RAF inference loop, accumulates `PoseFrame[]` |
| `useChoreography.ts` | Hook: fetches `choreography.json`, binary-search frame lookup by timestamp |
| `PoseOverlay.tsx` | Canvas: blue ghost reference skeleton + green live skeleton + score badge |
| `DanceStation.tsx` | Full 2-player host at `/dance-host` (mirrors `Host.tsx` flow) |

### Tools
| File | Purpose |
|------|---------|
| `tools/dance-prep/record_choreo.py` | Offline recorder: MediaPipe + OpenCV, exports `choreography.json` on SPACE key |
| `tools/dance-prep/requirements.txt` | `mediapipe>=0.10`, `opencv-python>=4.8` |
| `tools/pose-match/extract_poses.py` | One-shot: extracts all 33 landmarks from a reference `.mp4/.webm` |
| `tools/pose-match/pose_utils.py` | Normalisation + similarity functions + unit tests |
| `tools/pose-match/run.py` | Live webcam loop: 3-second countdown, blue/green skeleton overlay, score HUD |
| `tools/pose-match/pose_landmarker_full.task` | MediaPipe model (9 MB, float16) |

### Modified Files
| File | Change |
|------|--------|
| `frontend/src/game/types.ts` | Added `gamemode?: "karaoke" \| "dance"` to `RoomState` |
| `frontend/src/main.tsx` | Added `/dance-host` → `<DanceStation />` route |
| `backend/main.py` | Mounted `dance_router` at `/api` |
| `backend/orchestration/router.py` | Added optional `gamemode`, `p1_score`, `p2_score` fields |
| `backend/orchestration/finish.py` | Branches on `gamemode=dance` to use passed-in scores instead of scoring audio |

---

## How to Run

### Dance gamemode (in-app)

**Prerequisites (one-time):**
```bash
# Install MediaPipe npm package
cd frontend && npm install @mediapipe/tasks-vision

# Download the pose model into the public folder
curl -L -o frontend/public/models/pose_landmarker_full.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task"
```

**Record a reference choreography (once per song):**
```bash
cd tools/dance-prep
pip install -r requirements.txt
python3 record_choreo.py --song-id demo-dance
# SPACE to start/stop recording, Q to quit
# Outputs: assets/songs/demo-dance/choreography.json
```

**Play:**
1. Start backend: `cd backend && uvicorn main:app --reload`
2. Start frontend: `cd frontend && npm run dev`
3. Open `http://localhost:5173/dance-host` on the laptop
4. Players join via QR at `http://localhost:5173/play?code=XXXXXX`

### Standalone pose-match tool (no server needed)

```bash
cd tools/pose-match
pip install mediapipe opencv-python numpy

# Step 1 — extract reference poses from video (run once)
python3 extract_poses.py --video reference.mp4.webm

# Step 2 — live webcam comparison
python3 run.py           # loops until Q/ESC
python3 run.py --loop    # restart when reference ends
python3 run.py --camera 1  # if default camera index 0 doesn't work
```

Controls during `run.py`: `Q` or `ESC` to quit. A 3-second countdown gives you time to get in position before scoring starts.

---

## Scoring Design

### In-app authoritative scorer (`backend/dance/scorer.py`)

**Algorithm (mirrors pitch scorer invariants from `CLAUDE.md`):**
1. For each reference frame, search the player's captured frames within ±3 frames (±100 ms at 30 fps) — same window as the pitch scorer's ±30 ms.
2. Compute 8 joint angles per frame (position/scale invariant):
   - Left/right elbow angle (shoulder → elbow → wrist)
   - Left/right shoulder angle (hip → shoulder → elbow)
   - Left/right hip angle (shoulder → hip → knee)
   - Left/right knee angle (hip → knee → ankle)
3. Weighted mean angle error across all 8 joints.
4. **Hit** = weighted error ≤ 15°.
5. `score = 100 × frames_hit / frames_scored` (0–100, same shape as `Score` contract).

**Tunable constants in `backend/dance/scorer.py`:**
```python
ALIGN_FRAMES = 3       # ±3 frame search window (mirrors pitch scorer)
HIT_ANGLE_DEG = 15.0   # degrees — loosen to 20-25 for easier mode
MIN_VISIBILITY = 0.5   # MediaPipe landmark confidence threshold
```

### Standalone tool scorer (`tools/pose-match/pose_utils.py`)

**Algorithm:**
Cosine similarity of **limb segment direction vectors** — the vector from the proximal joint to the distal joint (e.g. shoulder→elbow), not the position of each joint in space.

**Why segment vectors, not position vectors:**
The first version compared each joint's *position vector* from the torso origin. This is a bad metric for dance because any standing person's joints hang below their torso in roughly the same direction as a reference person who is also standing, producing artificially high similarity (~0.7) even when the poses are completely different. Limb segment direction vectors (shoulder→elbow points in the direction the arm is actually extended) are directly sensitive to whether the arm is raised, lowered, or bent — the actual discriminating signal.

**Segments scored:**

| Segment | Weight | Reason |
|---------|--------|--------|
| L/R shoulder → elbow | 3.0 | Arms primary dance signal |
| L/R elbow → wrist | 3.0 | Arms primary dance signal |
| L/R hip → knee | 1.0 | Legs secondary (often stay planted) |
| L/R knee → ankle | 1.0 | Legs secondary |

Arms are weighted 3× because Just Dance choreography is arm-dominant. Leg segments stay similar even during active arm moves, so giving them equal weight inflates the score for a partially-wrong pose.

**Tunable constants in `tools/pose-match/pose_utils.py`:**
```python
MIN_VISIBILITY = 0.5          # confidence threshold to score a joint
MIN_QUALIFYING_SEGMENTS = 4   # bail out if fewer joints are visible
LIMB_SEGMENTS = [
    (11, 13, 3.0),  # shoulder → elbow weight
    (13, 15, 3.0),  # elbow → wrist weight
    ...
    (23, 25, 1.0),  # hip → knee weight
    ...
]
```

To make the tool harder to score high (e.g. for tighter calibration), increase arm weights or lower `MIN_VISIBILITY`. To make it more forgiving, reduce arm weights toward 1.0 or raise `MIN_QUALIFYING_SEGMENTS` higher so frames with occluded limbs are skipped entirely.

**Expected score ranges (standalone tool, 0–1 scale):**
| Situation | Score |
|-----------|-------|
| Actively matching the reference | 0.75–0.95 |
| Standing still while reference dances | 0.35–0.50 |
| Completely wrong pose / mirrored | 0.10–0.35 |
| Identical pose | 1.00 |

---

## MediaPipe Model Notes

- **Model:** `pose_landmarker_full.task` (float16, 9 MB)
  - Full model = best accuracy. Swap for `pose_landmarker_lite.task` (~3 MB) if latency is a problem on older hardware.
- **API:** mediapipe ≥ 0.10 uses `mediapipe.tasks.python.vision.PoseLandmarker`. The older `mp.solutions.pose` API was removed at 0.10.x.
- **Running mode:** `VIDEO` for both offline extraction and live webcam (monotonically increasing timestamps required).
- **GPU delegate:** enabled in-browser via WebAssembly. The Python tool runs CPU-only (sufficient at 30 fps on M-series Mac).
- **Confidence thresholds** (set at model init, not post-processing):
  ```python
  min_pose_detection_confidence=0.5
  min_pose_presence_confidence=0.5
  min_tracking_confidence=0.5
  ```
  Lower these if the dancer is frequently losing detection (far from camera, dark clothing). Raise to reduce false positives.

---

## Dependencies Added

**Python (system, `--break-system-packages`):**
- `mediapipe==0.10.35`
- `opencv-python==4.13.0.92`
- `numpy==2.4.6`

**npm:**
- `@mediapipe/tasks-vision` (frontend pose detection)
