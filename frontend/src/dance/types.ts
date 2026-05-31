/** Dance-mode types — mirrors contracts/dance.ts for frontend use. */

export interface PoseKeypoint {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface PoseFrame {
  t: number;
  keypoints: Record<string, PoseKeypoint>;
}

export interface ChoreographyContour {
  song_id: string;
  fps: number;
  frames: PoseFrame[];
}

export interface DanceScore {
  song_id: string;
  player_id: string;
  score: number;
  frames_scored: number;
  frames_hit: number;
}
