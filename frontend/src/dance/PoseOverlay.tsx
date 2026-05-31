/**
 * PoseOverlay — canvas component that renders:
 *   • Reference ghost skeleton (TARGET, magenta, semi-transparent)
 *   • Live detected skeleton (PLAYER, slime + cyan connections)
 *   • Per-joint landmark dots with ink stroke
 *   • Rolling score badge (top-right corner)
 *
 * Broadcast palette (presentation only): connections cyan, player dots slime,
 * target dots magenta, dots ringed with ink.
 */

import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { PoseFrame } from "./types";
import { PAL, FONT } from "@/ui";

// Simple stick-figure skeleton (pairs of MediaPipe landmark indices).
const CONNECTIONS: [number, number][] = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm: shoulder→elbow→hand
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso sides
  [23, 24], // hips
  [23, 25], [25, 27], // left leg: hip→knee→foot
  [24, 26], [26, 28], // right leg
];

// Only DOT these joints — a simple set: head, both shoulders/elbows/hands, knees, feet.
// (Skips the cluttered face/eye/ear/finger/heel landmarks.)
const DOT_INDICES = new Set([0, 11, 12, 13, 14, 15, 16, 25, 26, 27, 28]);

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
  connectionColor: string,
  dotColor: string,
  alpha: number,
  dotRadius = 5,
  lineWidth = 3,
  mirror = false,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const X = (i: number) => (mirror ? 1 - landmarks[i].x : landmarks[i].x) * width;
  const Y = (i: number) => landmarks[i].y * height;

  // Connections: cyan bones (broadcast).
  ctx.strokeStyle = connectionColor;
  ctx.lineWidth = lineWidth;
  for (const [a, b] of CONNECTIONS) {
    if (a >= landmarks.length || b >= landmarks.length) continue;
    ctx.beginPath();
    ctx.moveTo(X(a), Y(a));
    ctx.lineTo(X(b), Y(b));
    ctx.stroke();
  }

  // Landmark dots — only the simple joint set, filled accent with a chunky ink ring.
  ctx.fillStyle = dotColor;
  ctx.strokeStyle = PAL.ink;
  ctx.lineWidth = 2.5;
  for (let i = 0; i < landmarks.length; i++) {
    if (!DOT_INDICES.has(i)) continue;
    ctx.beginPath();
    ctx.arc(X(i), Y(i), dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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

    // Sync canvas bitmap resolution to its actual CSS display size so drawings
    // map 1:1 to the video pixels regardless of aspect ratio.
    const cw = canvas.offsetWidth || width;
    const ch = canvas.offsetHeight || height;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    ctx.clearRect(0, 0, cw, ch);

    if (!active) return;

    // Reference ghost skeleton (TARGET — magenta, not mirrored — raw coords match unmirrored video)
    if (referenceFrame) {
      const refLandmarks = refFrameToLandmarks(referenceFrame);
      drawSkeleton(ctx, refLandmarks, cw, ch, PAL.magenta, PAL.magenta, 0.45, 6, 5, false);
    }

    // Live skeleton (PLAYER — cyan bones, slime joints, mirrored to match webcam)
    if (liveLandmarks) {
      const live = liveLandmarks.map((lm) => ({ x: lm.x, y: lm.y }));
      drawSkeleton(ctx, live, cw, ch, PAL.cyan, PAL.slime, 0.95, 6, 5, true);
    }

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
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
