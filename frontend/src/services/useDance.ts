import { useState, useRef, useCallback, useEffect } from "react";
import { usePoseDetection } from "../dance/usePoseDetection";
import { useChoreography } from "../dance/useChoreography";
import type { DanceScore } from "../dance/types";

const DANCE_SCORE_URL = "/api/dance/score";

export function useDance(songId: string, onSongEnd?: () => void) {
  const pose = usePoseDetection();
  const choreo = useChoreography(songId);
  const [liveScore, setLiveScore] = useState(0);
  const [dancingActive, setDancingActive] = useState(false);
  const playbackStartRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // A dance turn auto-ends when the instrumental finishes. Keep the latest callback in a ref
  // so the "ended" listener (attached once at preload) always calls the current handler, and
  // only while a turn is actually active (dancingActive).
  const onSongEndRef = useRef(onSongEnd);
  onSongEndRef.current = onSongEnd;
  const dancingActiveRef = useRef(false);
  dancingActiveRef.current = dancingActive;

  // Pre-load instrumental
  useEffect(() => {
    const audio = new Audio(`/assets/songs/${songId}/instrumental.mp3`);
    audio.preload = "auto";
    const onEnded = () => { if (dancingActiveRef.current) onSongEndRef.current?.(); };
    audio.addEventListener("ended", onEnded);
    audioRef.current = audio;
    return () => { audio.removeEventListener("ended", onEnded); audio.pause(); };
  }, [songId]);

  // Cumulative hit tracking — incremented each scored frame, reset each turn.
  const framesHitRef = useRef(0);
  const framesScoredRef = useRef(0);
  // Rolling buffer for the instant quality label (popups), separate from cumulative.
  const scoreBuffer = useRef<number[]>([]);
  const refFrameRef = useRef<ReturnType<typeof choreo.getFrameAt>>(null);

  // Called by DanceHost each render with the current reference frame (video-synced).
  const scoreLiveFrame = useCallback((refFrame: ReturnType<typeof choreo.getFrameAt>) => {
    refFrameRef.current = refFrame;
  }, []);

  useEffect(() => {
    if (!dancingActive || !pose.landmarks) return;

    const refFrame = refFrameRef.current;
    if (!refFrame) {
      // No reference yet — show 0 rather than a misleading mid-range number.
      setLiveScore(0);
      return;
    }

    const LANDMARK_NAMES = ["nose","left_eye_inner","left_eye","left_eye_outer","right_eye_inner","right_eye","right_eye_outer","left_ear","right_ear","mouth_left","mouth_right","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_pinky","right_pinky","left_index","right_index","left_thumb","right_thumb","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle","left_heel","right_heel","left_foot_index","right_foot_index"];
    const JOINTS = ["left_shoulder","right_shoulder","left_elbow","right_elbow","left_hip","right_hip","left_knee","right_knee","left_wrist","right_wrist"];
    const kps = refFrame.keypoints as Record<string, { x: number; y: number; visibility: number }>;

    // Normalize both poses to hip-center + torso scale so scoring is position/distance agnostic.
    const lHipIdx = LANDMARK_NAMES.indexOf("left_hip");
    const rHipIdx = LANDMARK_NAMES.indexOf("right_hip");
    const lShIdx  = LANDMARK_NAMES.indexOf("left_shoulder");
    const rShIdx  = LANDMARK_NAMES.indexOf("right_shoulder");
    const liveL = pose.landmarks!;

    const liveCx = (liveL[lHipIdx].x + liveL[rHipIdx].x) / 2;
    const liveCy = (liveL[lHipIdx].y + liveL[rHipIdx].y) / 2;
    const liveScale = Math.hypot(
      (liveL[lShIdx].x + liveL[rShIdx].x) / 2 - liveCx,
      (liveL[lShIdx].y + liveL[rShIdx].y) / 2 - liveCy,
    ) || 1;

    const refLH = kps["left_hip"], refRH = kps["right_hip"];
    const refLS = kps["left_shoulder"], refRS = kps["right_shoulder"];
    if (!refLH || !refRH || !refLS || !refRS) return;
    const refCx = (refLH.x + refRH.x) / 2;
    const refCy = (refLH.y + refRH.y) / 2;
    const refScale = Math.hypot(
      (refLS.x + refRS.x) / 2 - refCx,
      (refLS.y + refRS.y) / 2 - refCy,
    ) || 1;

    // Max tolerated distance after normalization. 0.5 = half a torso-height off.
    const THRESHOLD = 0.5;

    const scores: number[] = [];
    for (const name of JOINTS) {
      const idx = LANDMARK_NAMES.indexOf(name);
      const live = liveL[idx];
      const ref = kps[name];
      if (!live || !ref) continue;
      if ((live.visibility ?? 0) < 0.4 || (ref.visibility ?? 0) < 0.4) continue;
      const lx = (live.x - liveCx) / liveScale;
      const ly = (live.y - liveCy) / liveScale;
      const rx = (ref.x - refCx) / refScale;
      const ry = (ref.y - refCy) / refScale;
      const dist = Math.sqrt((lx - rx) ** 2 + (ly - ry) ** 2);
      scores.push(Math.max(0, 1 - dist / THRESHOLD));
    }

    if (scores.length === 0) return;
    const frameQuality = scores.reduce((a, b) => a + b, 0) / scores.length * 100;

    // Cumulative tally: count this frame as a hit if quality >= 50%.
    framesScoredRef.current += 1;
    if (frameQuality >= 50) framesHitRef.current += 1;
    const cumulative = Math.round(framesHitRef.current / framesScoredRef.current * 100);
    setLiveScore(cumulative);

    // Also update rolling buffer so instant quality is available (used for popup label).
    scoreBuffer.current.push(frameQuality);
    if (scoreBuffer.current.length > 20) scoreBuffer.current.shift();
  }, [pose.landmarks, dancingActive]);

  const startDancing = useCallback(async () => {
    pose.resetFrames();
    framesHitRef.current = 0;
    framesScoredRef.current = 0;
    scoreBuffer.current = [];
    setLiveScore(0);
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
      const frames = pose.getFrames();
      const res = await fetch(DANCE_SCORE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song_id: songId,
          player_id: playerId.toLowerCase(),
          frames,
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

  // Instant quality (0-100) from the rolling buffer — used for popup labels so they
  // reflect right-now accuracy, not the cumulative total.
  const instantQuality = scoreBuffer.current.length
    ? Math.round(scoreBuffer.current.reduce((a, b) => a + b, 0) / scoreBuffer.current.length)
    : liveScore;

  return {
    videoRef: pose.videoRef,
    getFrameAt: choreo.getFrameAt,
    scoreLiveFrame,
    landmarks: pose.landmarks,
    liveScore,
    instantQuality,
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
