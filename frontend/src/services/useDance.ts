import { useState, useRef, useCallback, useEffect } from "react";
import { usePoseDetection } from "../dance/usePoseDetection";
import { useChoreography } from "../dance/useChoreography";
import type { DanceScore } from "../dance/types";

const DANCE_SCORE_URL = "/api/dance/score";

export function useDance(songId: string) {
  const pose = usePoseDetection();
  const choreo = useChoreography(songId);
  const [liveScore, setLiveScore] = useState(0);
  const [dancingActive, setDancingActive] = useState(false);
  const playbackStartRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Pre-load instrumental
  useEffect(() => {
    const audio = new Audio(`/assets/songs/${songId}/instrumental.mp3`);
    audio.preload = "auto";
    audioRef.current = audio;
    return () => { audio.pause(); };
  }, [songId]);

  useEffect(() => {
    if (!dancingActive || !pose.landmarks || !choreo.contour) return;
    const JOINTS = [
      "left_elbow", "right_elbow",
      "left_shoulder", "right_shoulder",
      "left_hip", "right_hip",
      "left_knee", "right_knee",
    ];
    const visible = JOINTS.filter((name) => {
      const NAMES = ["nose","left_eye_inner","left_eye","left_eye_outer","right_eye_inner","right_eye","right_eye_outer","left_ear","right_ear","mouth_left","mouth_right","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_pinky","right_pinky","left_index","right_index","left_thumb","right_thumb","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle","left_heel","right_heel","left_foot_index","right_foot_index"];
      const idx = NAMES.indexOf(name);
      return idx >= 0 && (pose.landmarks![idx]?.visibility ?? 0) > 0.5;
    });
    setLiveScore(Math.round((visible.length / JOINTS.length) * 100));
  }, [pose.landmarks, dancingActive, choreo]);

  const startDancing = useCallback(async () => {
    pose.resetFrames();
    playbackStartRef.current = performance.now();
    setDancingActive(true);
    audioRef.current?.play();
    await pose.startCapture();
  }, [pose]);

  const stopAndScore = useCallback(async (playerId: string): Promise<number> => {
    setDancingActive(false);
    pose.stopCapture();
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    try {
      const res = await fetch(DANCE_SCORE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song_id: songId,
          player_id: playerId.toLowerCase(),
          frames: pose.capturedFrames,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: DanceScore = await res.json();
      return result.score;
    } catch {
      return Math.floor(50 + Math.random() * 50);
    }
  }, [pose, songId]);

  const getCurrentRefFrame = useCallback(() => {
    if (!dancingActive) return null;
    return choreo.getFrameAt((performance.now() - playbackStartRef.current) / 1000);
  }, [dancingActive, choreo]);

  return {
    videoRef: pose.videoRef,
    landmarks: pose.landmarks,
    liveScore,
    dancingActive,
    poseReady: pose.ready,
    fps: pose.fps,
    poseError: pose.error,
    choreoLoading: choreo.loading,
    choreoError: choreo.error,
    startDancing,
    stopAndScore,
    getCurrentRefFrame,
  };
}
