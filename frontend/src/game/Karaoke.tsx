import { useState, useEffect, useRef, useCallback } from "react";

interface LyricLine {
  t: number;
  end: number;
  text: string;
}

interface LyricsData {
  song_id: string;
  segment_start_sec: number;
  lines: LyricLine[];
}

const SONGS: Record<string, { audio: string; lyrics: string; title: string; artist: string }> = {
  firework: {
    audio: "/songs/firework/instrumental.mp3",
    lyrics: "/songs/firework/lyrics.json",
    title: "Firework",
    artist: "Katy Perry",
  },
};

export default function Karaoke() {
  const [songId] = useState("firework");
  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number>(0);
  const activeLyricRef = useRef<HTMLDivElement>(null);

  // Load lyrics JSON
  useEffect(() => {
    fetch(SONGS[songId].lyrics)
      .then((r) => r.json())
      .then(setLyrics);
  }, [songId]);

  // RAF loop to sync lyrics with audio time
  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    setCurrentTime(t);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, tick]);

  // Find active lyric line
  useEffect(() => {
    if (!lyrics) return;
    const idx = lyrics.lines.findIndex((l) => currentTime >= l.t && currentTime < l.end);
    setActiveIdx(idx);
  }, [currentTime, lyrics]);

  // Scroll active line into view
  useEffect(() => {
    activeLyricRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play();
      setPlaying(true);
    }
  };

  const restart = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play();
    setPlaying(true);
  };

  const song = SONGS[songId];
  const progress = audioRef.current?.duration
    ? (currentTime / audioRef.current.duration) * 100
    : 0;

  return (
    <div style={s.root}>
      <audio ref={audioRef} src={song.audio} onEnded={() => setPlaying(false)} />

      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.songTitle}>{song.title}</div>
          <div style={s.songArtist}>{song.artist}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={restart}>↺</Btn>
          <Btn onClick={togglePlay} primary>{playing ? "⏸ Pause" : "▶ Play"}</Btn>
        </div>
      </div>

      {/* Progress bar */}
      <div style={s.progressTrack}>
        <div style={{ ...s.progressFill, width: `${progress}%` }} />
      </div>

      {/* Lyrics display */}
      <div style={s.lyricsBox}>
        {!lyrics && <div style={s.placeholder}>Loading lyrics…</div>}
        {lyrics?.lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <div
              key={i}
              ref={isActive ? activeLyricRef : undefined}
              style={{
                ...s.lyricLine,
                color: isActive ? "#facc15" : isPast ? "#374151" : "#9ca3af",
                fontSize: isActive ? 28 : 20,
                fontWeight: isActive ? 800 : 400,
                transform: isActive ? "scale(1.04)" : "scale(1)",
                textShadow: isActive ? "0 0 20px #facc1588" : "none",
                transition: "all 0.15s ease",
              }}
            >
              {line.text}
            </div>
          );
        })}
      </div>

      {/* Time */}
      <div style={s.timeRow}>
        <span style={s.time}>{fmt(currentTime)}</span>
        <span style={s.time}>{audioRef.current?.duration ? fmt(audioRef.current.duration) : "--:--"}</span>
      </div>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function Btn({ onClick, children, primary }: { onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button onClick={onClick} style={{
      background: primary ? "#8b5cf6" : "#1f1f1f",
      color: "#fff", border: "1px solid #333",
      borderRadius: 8, padding: "8px 18px",
      cursor: "pointer", fontSize: 14, fontWeight: 600,
    }}>
      {children}
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#050505", color: "#fff", fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", padding: 24 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  songTitle: { fontSize: 22, fontWeight: 800 },
  songArtist: { fontSize: 13, color: "#6b7280", marginTop: 2 },
  progressTrack: { height: 4, background: "#1f1f1f", borderRadius: 2, marginBottom: 32, overflow: "hidden" },
  progressFill: { height: "100%", background: "#8b5cf6", borderRadius: 2, transition: "width 0.1s linear" },
  lyricsBox: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "40px 0" },
  lyricLine: { textAlign: "center", lineHeight: 1.3, maxWidth: 600, cursor: "default" },
  placeholder: { color: "#555", marginTop: 60 },
  timeRow: { display: "flex", justifyContent: "space-between", color: "#6b7280", fontSize: 12, marginTop: 12 },
  time: { fontFamily: "monospace" },
};
