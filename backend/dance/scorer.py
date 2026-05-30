"""Authoritative dance scoring via joint-angle comparison.

Algorithm mirrors the pitch scorer invariants:
- For each reference frame with sufficient landmark visibility, search singer
  frames within ±ALIGN_FRAMES (same 3-frame window as pitch scorer).
- Compare 8 key joint angles (position/scale invariant).
- Compute weighted mean angle error per frame.
- A hit is weighted_error <= HIT_ANGLE_DEG (15°).
- score = 100 * frames_hit / frames_scored.
"""

from __future__ import annotations

import math
from typing import Any

# Mirrors ALIGN_FRAMES from scoring/scorer.py
ALIGN_FRAMES = 3
HIT_ANGLE_DEG = 15.0
MIN_VISIBILITY = 0.5  # landmark must exceed this to be scored

# (vertex, p1, p2) triplets — angle at vertex
_JOINT_TRIPLETS: list[tuple[str, str, str, float]] = [
    ("left_elbow",    "left_shoulder",  "left_wrist",    1.5),
    ("right_elbow",   "right_shoulder", "right_wrist",   1.5),
    ("left_shoulder", "left_hip",       "left_elbow",    1.0),
    ("right_shoulder","right_hip",      "right_elbow",   1.0),
    ("left_hip",      "left_shoulder",  "left_knee",     1.0),
    ("right_hip",     "right_shoulder", "right_knee",    1.0),
    ("left_knee",     "left_hip",       "left_ankle",    1.5),
    ("right_knee",    "right_hip",      "right_ankle",   1.5),
]

_WEIGHT_SUM = sum(w for *_, w in _JOINT_TRIPLETS)


def _angle_deg(p_vertex: dict, p1: dict, p2: dict) -> float:
    """Angle at p_vertex formed by the vectors to p1 and p2 (degrees)."""
    ax = p1["x"] - p_vertex["x"]
    ay = p1["y"] - p_vertex["y"]
    bx = p2["x"] - p_vertex["x"]
    by = p2["y"] - p_vertex["y"]
    dot = ax * bx + ay * by
    mag_a = math.hypot(ax, ay)
    mag_b = math.hypot(bx, by)
    if mag_a < 1e-9 or mag_b < 1e-9:
        return 0.0
    cos_t = max(-1.0, min(1.0, dot / (mag_a * mag_b)))
    return math.degrees(math.acos(cos_t))


def _frame_angles(keypoints: dict[str, Any]) -> dict[str, float]:
    """Compute all 8 joint angles for a single pose frame."""
    angles: dict[str, float] = {}
    for vertex, p1_name, p2_name, _ in _JOINT_TRIPLETS:
        kp = keypoints
        if (
            vertex in kp and p1_name in kp and p2_name in kp
            and kp[vertex].get("visibility", 0) >= MIN_VISIBILITY
            and kp[p1_name].get("visibility", 0) >= MIN_VISIBILITY
            and kp[p2_name].get("visibility", 0) >= MIN_VISIBILITY
        ):
            angles[vertex] = _angle_deg(kp[vertex], kp[p1_name], kp[p2_name])
    return angles


def _weighted_angle_error(ref_angles: dict[str, float], singer_angles: dict[str, float]) -> float | None:
    """Weighted mean angle error across available joints. None if no joints scoreable."""
    total_weight = 0.0
    total_error = 0.0
    for vertex, _, _, weight in _JOINT_TRIPLETS:
        if vertex in ref_angles and vertex in singer_angles:
            total_error += weight * abs(ref_angles[vertex] - singer_angles[vertex])
            total_weight += weight
    if total_weight < 1e-9:
        return None
    return total_error / total_weight


def score_take(singer_frames: list[dict], contour: dict, player_id: str) -> dict:
    """Score a dancer's performance against a reference choreography.

    Args:
        singer_frames: list of PoseFrame dicts captured from the browser
                       [{"t": float, "keypoints": {...}}, ...]
        contour: ChoreographyContour dict (from choreography.json)
        player_id: "p1" or "p2"

    Returns:
        DanceScore dict matching contracts/dance.ts
    """
    song_id = contour["song_id"]
    fps = contour.get("fps", 30)
    frame_interval = 1.0 / fps

    # Pre-compute angles for all singer frames
    singer_angles_by_idx = [
        _frame_angles(f.get("keypoints", {})) for f in singer_frames
    ]
    singer_times = [f["t"] for f in singer_frames]

    frames_scored = 0
    frames_hit = 0

    for ref_frame in contour["frames"]:
        ref_kps = ref_frame.get("keypoints", {})
        ref_angles = _frame_angles(ref_kps)
        if not ref_angles:
            continue
        frames_scored += 1

        ref_t = ref_frame["t"]
        window_s = ALIGN_FRAMES * frame_interval

        # Find singer frames within ±ALIGN_FRAMES of the reference timestamp
        candidates = [
            i for i, t in enumerate(singer_times)
            if abs(t - ref_t) <= window_s
        ]
        if not candidates:
            continue

        # Pick the candidate with the smallest weighted angle error
        best_error: float | None = None
        for idx in candidates:
            err = _weighted_angle_error(ref_angles, singer_angles_by_idx[idx])
            if err is not None and (best_error is None or err < best_error):
                best_error = err

        if best_error is not None and best_error <= HIT_ANGLE_DEG:
            frames_hit += 1

    return {
        "song_id": song_id,
        "player_id": player_id,
        "score": round(100 * frames_hit / frames_scored) if frames_scored else 0,
        "frames_scored": frames_scored,
        "frames_hit": frames_hit,
    }
