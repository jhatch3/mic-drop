/**
 * useChoreography — loads choreography.json for a song and returns the
 * reference frame closest to the current playback time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChoreographyContour, PoseFrame } from "./types";

export interface ChoreographyState {
  contour: ChoreographyContour | null;
  loading: boolean;
  error: string | null;
  /** Reference frame nearest to the given playback time (seconds). */
  getFrameAt: (t: number) => PoseFrame | null;
}

export function useChoreography(songId: string | null): ChoreographyState {
  const [contour, setContour] = useState<ChoreographyContour | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contourRef = useRef<ChoreographyContour | null>(null);

  useEffect(() => {
    if (!songId) return;
    setLoading(true);
    setError(null);
    fetch(`/assets/songs/${songId}/choreography.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ChoreographyContour>;
      })
      .then((data) => {
        contourRef.current = data;
        setContour(data);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [songId]);

  const getFrameAt = useCallback((t: number): PoseFrame | null => {
    const c = contourRef.current;
    if (!c || c.frames.length === 0) return null;
    // Binary search for nearest frame
    let lo = 0, hi = c.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c.frames[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    // Pick closest of lo-1 and lo
    if (lo > 0 && Math.abs(c.frames[lo - 1].t - t) < Math.abs(c.frames[lo].t - t)) {
      return c.frames[lo - 1];
    }
    return c.frames[lo];
  }, []);

  return { contour, loading, error, getFrameAt };
}
