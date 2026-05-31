/**
 * usePoseDetection — wraps @mediapipe/tasks-vision PoseLandmarker.
 *
 * Manages the webcam stream and runs pose inference on every animation frame.
 * Exports the latest normalized landmarks and accumulates all PoseFrames for
 * end-of-round authoritative scoring.
 *
 * Model file must be placed at /public/models/pose_landmarker_full.task.
 * Download from:
 *   https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { PoseFrame } from "./types";

const MODEL_PATH = "/models/pose_landmarker_full.task";

// MediaPipe landmark index → name (33 points)
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

export interface PoseDetectionState {
  landmarks: NormalizedLandmark[] | null;
  ready: boolean;
  error: string | null;
  fps: number;
  /** All frames captured since last resetFrames() call. */
  capturedFrames: PoseFrame[];
  startCapture: () => void;
  stopCapture: () => void;
  resetFrames: () => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}

export function usePoseDetection(): PoseDetectionState {
  const videoRef = useRef<HTMLVideoElement>(null!);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef(false);
  const capturedFramesRef = useRef<PoseFrame[]>([]);
  const startTimeRef = useRef<number>(0);

  const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [capturedFrames, setCapturedFrames] = useState<PoseFrame[]>([]);

  // Initialize MediaPipe PoseLandmarker once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
        );
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        if (!cancelled) {
          landmarkerRef.current = landmarker;
          setReady(true);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Start webcam + inference loop
  const startCapture = useCallback(async () => {
    if (!ready || !landmarkerRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      captureRef.current = true;
      startTimeRef.current = performance.now();

      let lastFrameTime = 0;
      let fpsFrames = 0;
      let fpsTimer = performance.now();

      const loop = () => {
        if (!captureRef.current) return;
        const now = performance.now();
        if (video.readyState >= 2 && now !== lastFrameTime) {
          const result = landmarkerRef.current!.detectForVideo(video, now);
          lastFrameTime = now;

          if (result.landmarks.length > 0) {
            const lms = result.landmarks[0];
            setLandmarks(lms);

            // Accumulate frame
            const t = (now - startTimeRef.current) / 1000;
            const keypoints: Record<string, { x: number; y: number; z: number; visibility: number }> = {};
            lms.forEach((lm, i) => {
              keypoints[LANDMARK_NAMES[i]] = {
                x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility ?? 1,
              };
            });
            capturedFramesRef.current.push({ t, keypoints });

            fpsFrames++;
            if (now - fpsTimer >= 1000) {
              setFps(fpsFrames);
              fpsFrames = 0;
              fpsTimer = now;
            }
          } else {
            setLandmarks(null);
          }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setError(`Webcam error: ${String(e)}`);
    }
  }, [ready]);

  const stopCapture = useCallback(() => {
    captureRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCapturedFrames([...capturedFramesRef.current]);
  }, []);

  const resetFrames = useCallback(() => {
    capturedFramesRef.current = [];
    setCapturedFrames([]);
    startTimeRef.current = performance.now();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      captureRef.current = false;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    landmarks, ready, error, fps, capturedFrames,
    startCapture, stopCapture, resetFrames, videoRef,
  };
}
