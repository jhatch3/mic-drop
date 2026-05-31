"""pose_utils.py — normalization and similarity for pose matching.

Works with mediapipe.tasks (>=0.10) landmark format:
  each landmark is an object with .x, .y, .z, .visibility (all floats, 0-1 range).

Can also accept plain dicts with those keys (used when loading from JSON).

Similarity is computed over LIMB SEGMENT direction vectors (shoulder→elbow,
elbow→wrist, hip→knee, knee→ankle), NOT position vectors from the torso
origin. Position vectors cluster near the same directions (joints hang below
the torso) so they produce artificially high similarity for neutral/standing
poses. Segment direction vectors are sensitive to actual pose configuration.
"""

from __future__ import annotations

import math
import unittest
from typing import Any


MIN_VISIBILITY = 0.5
MIN_QUALIFYING_SEGMENTS = 4

# (proximal, distal, weight) — direction = distal - proximal
# Arms weighted 2× legs: Just Dance choreography is arm-dominant; leg segments
# stay similar even when arms are active, so arm segments need more influence.
LIMB_SEGMENTS: list[tuple[int, int, float]] = [
    (11, 13, 3.0),  # left  shoulder → elbow
    (13, 15, 3.0),  # left  elbow   → wrist
    (12, 14, 3.0),  # right shoulder → elbow
    (14, 16, 3.0),  # right elbow   → wrist
    (23, 25, 1.0),  # left  hip     → knee
    (25, 27, 1.0),  # left  knee    → ankle
    (24, 26, 1.0),  # right hip     → knee
    (26, 28, 1.0),  # right knee    → ankle
]

# Kept for backward-compat imports in run.py
KEY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]


def _get(lm: Any, attr: str) -> float:
    """Access landmark attribute whether it's an object or a dict."""
    if isinstance(lm, dict):
        return float(lm[attr])
    return float(getattr(lm, attr))


def normalize_pose(landmarks: list[Any]) -> list[tuple[float, float, float]] | None:
    """Normalize a pose relative to torso (camera-distance invariant).

    Returns 33 (nx, ny, nz) tuples, or None if the torso isn't visible.
    Used for display/debugging; similarity() uses segment vectors instead.
    """
    if landmarks is None or len(landmarks) < 33:
        return None

    hip_x = (_get(landmarks[23], "x") + _get(landmarks[24], "x")) / 2
    hip_y = (_get(landmarks[23], "y") + _get(landmarks[24], "y")) / 2
    hip_z = (_get(landmarks[23], "z") + _get(landmarks[24], "z")) / 2
    sh_x  = (_get(landmarks[11], "x") + _get(landmarks[12], "x")) / 2
    sh_y  = (_get(landmarks[11], "y") + _get(landmarks[12], "y")) / 2
    sh_z  = (_get(landmarks[11], "z") + _get(landmarks[12], "z")) / 2

    torso_scale = math.sqrt(
        (sh_x - hip_x) ** 2 + (sh_y - hip_y) ** 2 + (sh_z - hip_z) ** 2
    )
    if torso_scale < 0.01:
        return None

    return [
        (
            (_get(lm, "x") - hip_x) / torso_scale,
            (_get(lm, "y") - hip_y) / torso_scale,
            (_get(lm, "z") - hip_z) / torso_scale,
        )
        for lm in landmarks
    ]


def _cosine_2d(ax: float, ay: float, bx: float, by: float) -> float:
    mag_a = math.sqrt(ax * ax + ay * ay)
    mag_b = math.sqrt(bx * bx + by * by)
    if mag_a < 1e-9 or mag_b < 1e-9:
        return 0.0
    return max(-1.0, min(1.0, (ax * bx + ay * by) / (mag_a * mag_b)))


def similarity(
    ref_landmarks: list[Any] | None,
    live_landmarks: list[Any] | None,
) -> float | None:
    """Compute pose similarity score in [0, 1] using limb segment directions.

    For each LIMB_SEGMENT (proximal, distal):
      - Skip if either endpoint has visibility < 0.5 in ref OR live.
      - Compute 2D direction vector (distal.xy - proximal.xy) for ref and live.
      - Cosine similarity of the two direction vectors, mapped to [0,1].

    Returns None if fewer than MIN_QUALIFYING_SEGMENTS pass the visibility check.

    Why segments, not positions: a person standing still has most joints below
    the torso regardless of what the reference is doing, so position-vector
    cosine similarity inflates toward ~0.7 even for completely wrong poses.
    Segment direction vectors are sensitive to whether the arm/leg is actually
    raised, extended, or bent — the actual discriminating information.
    """
    if ref_landmarks is None or live_landmarks is None:
        return None

    weighted_sum = 0.0
    total_weight = 0.0
    qualifying = 0

    for prox, dist, weight in LIMB_SEGMENTS:
        if prox >= len(ref_landmarks) or dist >= len(ref_landmarks):
            continue
        if prox >= len(live_landmarks) or dist >= len(live_landmarks):
            continue

        # Visibility check on both endpoints in both frames
        if (
            _get(ref_landmarks[prox],  "visibility") < MIN_VISIBILITY
            or _get(ref_landmarks[dist], "visibility") < MIN_VISIBILITY
            or _get(live_landmarks[prox],  "visibility") < MIN_VISIBILITY
            or _get(live_landmarks[dist], "visibility") < MIN_VISIBILITY
        ):
            continue

        # Direction vector in image coords (scale-invariant by construction)
        rdx = _get(ref_landmarks[dist],  "x") - _get(ref_landmarks[prox],  "x")
        rdy = _get(ref_landmarks[dist],  "y") - _get(ref_landmarks[prox],  "y")
        ldx = _get(live_landmarks[dist], "x") - _get(live_landmarks[prox], "x")
        ldy = _get(live_landmarks[dist], "y") - _get(live_landmarks[prox], "y")

        cos = _cosine_2d(rdx, rdy, ldx, ldy)
        weighted_sum += weight * (1.0 + cos) / 2.0
        total_weight += weight
        qualifying += 1

    if qualifying < MIN_QUALIFYING_SEGMENTS:
        return None
    return weighted_sum / total_weight


# ─── Unit tests ────────────────────────────────────────────────────────────────

class _FL:
    """Fake landmark."""
    def __init__(self, x, y, z=0.0, visibility=1.0):
        self.x = x; self.y = y; self.z = z; self.visibility = visibility


def _pose(overrides: dict[int, tuple[float, float]], vis: float = 1.0) -> list[_FL]:
    """33-landmark list. Default: joints in a plausible standing position."""
    # Default: standing, arms at sides
    defaults = {
        11: (0.40, 0.25),  # L shoulder
        12: (0.60, 0.25),  # R shoulder
        13: (0.38, 0.40),  # L elbow (arm down)
        14: (0.62, 0.40),  # R elbow
        15: (0.37, 0.55),  # L wrist
        16: (0.63, 0.55),  # R wrist
        23: (0.42, 0.60),  # L hip
        24: (0.58, 0.60),  # R hip
        25: (0.42, 0.75),  # L knee
        26: (0.58, 0.75),  # R knee
        27: (0.42, 0.90),  # L ankle
        28: (0.58, 0.90),  # R ankle
    }
    lms = [_FL(0.5, 0.5, visibility=vis) for _ in range(33)]
    for idx, (x, y) in defaults.items():
        lms[idx] = _FL(x, y, visibility=vis)
    for idx, (x, y) in overrides.items():
        lms[idx] = _FL(x, y, visibility=vis)
    return lms


class TestSimilarity(unittest.TestCase):
    def test_identical_pose_scores_one(self):
        lms = _pose({})
        score = similarity(lms, lms)
        self.assertIsNotNone(score)
        self.assertAlmostEqual(score, 1.0, places=5)

    def test_low_visibility_returns_none(self):
        lms = _pose({}, vis=0.1)
        self.assertIsNone(similarity(lms, lms))

    def test_standing_still_vs_arms_raised_scores_low(self):
        """Arms raised (both elbows above shoulders) vs arms at sides: arm segments
        point opposite directions → weighted score well below 0.5."""
        standing = _pose({})
        arms_up = _pose({
            13: (0.25, 0.10),  # L elbow raised above shoulder
            15: (0.15, 0.05),  # L wrist high
            14: (0.75, 0.10),  # R elbow raised
            16: (0.85, 0.05),  # R wrist high
        })
        score = similarity(standing, arms_up)
        self.assertIsNotNone(score)
        self.assertLess(score, 0.50)

    def test_mirrored_arms_scores_lower_than_exact(self):
        """A horizontally mirrored arm pose should score lower than the exact pose."""
        ref = _pose({13: (0.25, 0.30), 15: (0.15, 0.35)})   # L arm extended left
        exact = _pose({13: (0.25, 0.30), 15: (0.15, 0.35)})
        mirrored = _pose({13: (0.75, 0.30), 15: (0.85, 0.35)})  # mirrored to right
        self.assertGreater(similarity(ref, exact), similarity(ref, mirrored))


if __name__ == "__main__":
    unittest.main()
