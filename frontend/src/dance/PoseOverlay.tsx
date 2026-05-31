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
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Mirror X to match the selfie-mirrored video (transform: scaleX(-1)), so the points line
  // up with the player instead of appearing on the opposite side.
  const X = (i: number) => (1 - landmarks[i].x) * width;
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

    ctx.clearRect(0, 0, width, height);

    if (!active) return;

    // Reference ghost skeleton (TARGET — magenta)
    if (referenceFrame) {
      const refLandmarks = refFrameToLandmarks(referenceFrame);
      drawSkeleton(ctx, refLandmarks, width, height, PAL.magenta, PAL.magenta, 0.45, 6, 5);
    }

    // Live skeleton (PLAYER — cyan bones, slime joints)
    if (liveLandmarks) {
      const live = liveLandmarks.map((lm) => ({ x: lm.x, y: lm.y }));
      drawSkeleton(ctx, live, width, height, PAL.cyan, PAL.slime, 0.95, 6, 5);
    }

    // Score badge
    const badgeColor = score >= 70 ? PAL.slime : score >= 40 ? PAL.yellow : PAL.red;
    const badgeX = width - 90;
    const badgeY = 16;
    ctx.save();
    // Ink panel with chunky offset shadow (broadcast bevel feel).
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(badgeX - 4, badgeY, 96, 48);
    ctx.fillStyle = "rgba(11,11,11,0.88)";
    ctx.fillRect(badgeX - 8, badgeY - 4, 96, 48);
    ctx.strokeStyle = PAL.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(badgeX - 8, badgeY - 4, 96, 48);
    // Score number — Anton display, ink shadow for legibility.
    ctx.font = `36px ${FONT.display}`;
    ctx.textAlign = "right";
    ctx.fillStyle = PAL.ink;
    ctx.fillText(`${score}`, width - 14, badgeY + 36);
    ctx.fillStyle = badgeColor;
    ctx.fillText(`${score}`, width - 16, badgeY + 34);
    // Label — VT323 mono "TV" status type.
    ctx.font = `15px ${FONT.mono}`;
    ctx.fillStyle = PAL.cyan;
    ctx.textAlign = "left";
    ctx.fillText("SCORE", badgeX, badgeY + 13);
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
