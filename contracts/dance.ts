/** Dance gamemode shared contracts — source of truth for all streams. */

export interface PoseKeypoint {
  x: number;          // normalized [0,1] relative to image width
  y: number;          // normalized [0,1] relative to image height
  z: number;          // depth relative to hip midpoint
  visibility: number; // [0,1] confidence
}

export interface PoseFrame {
  t: number;                               // segment-relative time (seconds)
  keypoints: Record<string, PoseKeypoint>; // MediaPipe landmark names as keys
}

export interface ChoreographyContour {
  song_id: string;
  fps: number;          // capture frame rate (typically 30)
  frames: PoseFrame[];
}

/** Authoritative dance score — mirrors Score shape from spec 3.4 */
export interface DanceScore {
  song_id: string;
  player_id: string;
  score: number;         // 0–100 = 100 * frames_hit / frames_scored
  frames_scored: number; // reference frames with ≥1 visible landmark
  frames_hit: number;    // frames within weighted joint-angle threshold
}

/** Key joint names used for scoring (subset of MediaPipe 33-point model). */
export const SCORED_JOINTS = [
  "left_elbow",
  "right_elbow",
  "left_shoulder",
  "right_shoulder",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
] as const;

export type ScoredJoint = (typeof SCORED_JOINTS)[number];

/** Per-joint score weights (must sum to 1 after normalization). */
export const JOINT_WEIGHTS: Record<ScoredJoint, number> = {
  left_elbow: 1.5,
  right_elbow: 1.5,
  left_shoulder: 1.0,
  right_shoulder: 1.0,
  left_hip: 1.0,
  right_hip: 1.0,
  left_knee: 1.5,
  right_knee: 1.5,
};

/** Weighted mean joint-angle error threshold for a "hit" (degrees). */
export const HIT_ANGLE_DEG = 15;

/** Frame search window (±N frames) — mirrors ALIGN_FRAMES from pitch scorer. */
export const ALIGN_FRAMES = 3;
