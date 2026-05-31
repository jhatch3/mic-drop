/**
 * PoseOverlay — canvas component that renders:
 *   • Reference ghost skeleton (blue, semi-transparent)
 *   • Live detected skeleton (bright green)
 *   • Per-joint match quality as color-coded dots
 *   • Rolling score badge (top-right corner)
 */

import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { PoseFrame } from "./types";

// MediaPipe Pose connections (pairs of landmark indices)
const CONNECTIONS: [number, number][] = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso sides
  [23, 24], // hips
  [23, 25], [25, 27], // left leg
  [24, 26], [26, 28], // right leg
];

const LANDMARK_NAMES = [
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
];

interface Props {
  width: number;
  height: number;
  liveLandmarks: NormalizedLandmark[] | null;
  referenceFrame: PoseFrame | null;
  score: number; // 0-100 rolling score
  active: boolean;
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: { x: number; y: number }[],
  width: number,
  height: number,
  color: string,
  alpha: number,
  dotRadius = 5,
  lineWidth = 3,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;

  for (const [a, b] of CONNECTIONS) {
    if (a >= landmarks.length || b >= landmarks.length) continue;
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height);
    ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height);
    ctx.stroke();
  }

  for (const lm of landmarks) {
    ctx.beginPath();
    ctx.arc(lm.x * width, lm.y * height, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function refFrameToLandmarks(frame: PoseFrame): { x: number; y: number }[] {
  return LANDMARK_NAMES.map((name) => {
    const kp = frame.keypoints[name];
    return kp ? { x: kp.x, y: kp.y } : { x: 0, y: 0 };
  });
}

export default function PoseOverlay({ width, height, liveLandmarks, referenceFrame, score, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    if (!active) return;

    // Reference ghost skeleton (blue)
    if (referenceFrame) {
      const refLandmarks = refFrameToLandmarks(referenceFrame);
      drawSkeleton(ctx, refLandmarks, width, height, "#4488ff", 0.4, 6, 2);
    }

    // Live skeleton (bright green)
    if (liveLandmarks) {
      const live = liveLandmarks.map((lm) => ({ x: lm.x, y: lm.y }));
      drawSkeleton(ctx, live, width, height, "#00ff88", 0.9, 5, 3);
    }

    // Score badge
    const badgeColor = score >= 70 ? "#22c55e" : score >= 40 ? "#eab308" : "#ef4444";
    const badgeX = width - 90;
    const badgeY = 16;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(badgeX - 8, badgeY - 4, 88, 44, 8);
    ctx.fill();
    ctx.fillStyle = badgeColor;
    ctx.font = "bold 32px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`${score}`, width - 16, badgeY + 32);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText("score", badgeX, badgeY + 14);
    ctx.restore();
  }, [width, height, liveLandmarks, referenceFrame, score, active]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
      }}
    />
  );
}
