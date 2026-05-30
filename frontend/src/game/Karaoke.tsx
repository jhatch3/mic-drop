import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LyricLine { t: number; end: number; text: string; }
interface ContourFrame { t: number; midi: number | null; voiced: boolean; }
interface Word { word: string; start: number; end: number; }

// Split a lyric line into words with linearly interpolated timestamps
function wordsForLine(line: LyricLine): Word[] {
  const tokens = line.text.split(/\s+/).filter(Boolean);
  const dur = line.end - line.t;
  return tokens.map((word, i) => ({
    word,
    start: line.t + (i / tokens.length) * dur,
    end:   line.t + ((i + 1) / tokens.length) * dur,
  }));
}

const SONG = {
  audio:   "/songs/firework/instrumental.mp3",
  lyrics:  "/songs/firework/lyrics.json",
  contour: "/songs/firework/contour.json",
  title:   "Firework",
  artist:  "Katy Perry",
};

// ─── Pitch detection (autocorrelation, ported from backend/common/pitch.py) ──
const SR        = 44100; // browser AudioContext default
const FMIN      = 65;    // C2 Hz
const FMAX      = 1000;  // B5 Hz
const RMS_GATE  = 0.003;
const CONF_MIN  = 0.5;

function detectPitch(buf: Float32Array): { midi: number | null; conf: number } {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < RMS_GATE) return { midi: null, conf: 0 };

  const minLag = Math.floor(SR / FMAX);
  const maxLag = Math.min(n - 1, Math.floor(SR / FMIN));

  // Autocorrelation
  let best = -1, bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += buf[i] * buf[i + lag];
    if (sum > bestVal) { bestVal = sum; best = lag; }
  }

  let norm = 0;
  for (let i = 0; i < n; i++) norm += buf[i] * buf[i];
  const conf = norm > 0 ? bestVal / norm : 0;
  if (conf < CONF_MIN || best <= 0) return { midi: null, conf };

  const f0 = SR / best;
  const midi = 69 + 12 * Math.log2(f0 / 440);
  return { midi, conf };
}

// Octave-folded cents error (from CLAUDE.md spec)
function centsError(singer: number, target: number): number {
  const diff = singer - target;
  return (diff - 12 * Math.round(diff / 12)) * 100;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Karaoke() {
  const [lines, setLines]       = useState<LyricLine[]>([]);
  const [contour, setContour]   = useState<ContourFrame[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [playing, setPlaying]   = useState(false);
  const [micOn, setMicOn]       = useState(false);
  const [score, setScore]       = useState(0);
  const [hits, setHits]         = useState(0);
  const [scored, setScored]     = useState(0);
  const [liveMidi, setLiveMidi] = useState<number | null>(null);
  const [targetMidi, setTargetMidi] = useState<number | null>(null);

  const audioRef    = useRef<HTMLAudioElement>(null);
  const rafRef      = useRef<number>(0);
  const activeLyricRef = useRef<HTMLDivElement>(null);
  const ctxRef      = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const hitsRef     = useRef(0);
  const scoredRef   = useRef(0);

  // Load assets
  useEffect(() => {
    fetch(SONG.lyrics).then(r => r.json()).then(d => setLines(d.lines));
    fetch(SONG.contour).then(r => r.json()).then(d => setContour(d.frames));
  }, []);

  // Main RAF loop
  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;

    // Active lyric line
    setActiveIdx(prev => {
      const idx = lines.findIndex(l => t >= l.t && t < l.end);
      return idx === -1 ? prev : idx;
    });

    // Live pitch vs contour
    if (analyserRef.current && contour.length > 0) {
      const buf = new Float32Array(analyserRef.current.fftSize);
      analyserRef.current.getFloatTimeDomainData(buf);
      const { midi, conf } = detectPitch(buf);
      setLiveMidi(midi);

      // Find target frame (nearest voiced frame within ±30ms)
      const target = contour.find(f => f.voiced && f.midi !== null && Math.abs(f.t - t) <= 0.03) ?? null;
      setTargetMidi(target?.midi ?? null);

      if (target && target.midi !== null) {
        scoredRef.current += 1;
        if (midi !== null && conf >= CONF_MIN) {
          const err = centsError(midi, target.midi);
          if (Math.abs(err) <= 50) hitsRef.current += 1;
        }
        const pct = scoredRef.current > 0
          ? Math.round(100 * hitsRef.current / scoredRef.current)
          : 0;
        setHits(hitsRef.current);
        setScored(scoredRef.current);
        setScore(pct);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [lines, contour]);

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, tick]);

  // Scroll active lyric into view
  useEffect(() => {
    activeLyricRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    streamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: SR });
    ctxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyserRef.current = analyser;
    setMicOn(true);
  }, []);

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    ctxRef.current?.close();
    analyserRef.current = null;
    setMicOn(false);
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      if (!micOn) await startMic();
      await audio.play();
      setPlaying(true);
    }
  }, [playing, micOn, startMic]);

  const restart = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    hitsRef.current = 0;
    scoredRef.current = 0;
    setHits(0); setScored(0); setScore(0); setActiveIdx(-1);
    if (!micOn) await startMic();
    await audio.play();
    setPlaying(true);
  }, [micOn, startMic]);

  useEffect(() => () => { stopMic(); cancelAnimationFrame(rafRef.current); }, [stopMic]);

  // Score colour
  const scoreColor = score >= 80 ? "#4ade80" : score >= 50 ? "#facc15" : "#f87171";

  // Pitch indicator
  const midiLabel = (m: number | null) =>
    m !== null ? `${noteFromMidi(m)} (${m.toFixed(1)})` : "—";

  const audio = audioRef.current;
  const progress = audio?.duration ? (audio.currentTime / audio.duration) * 100 : 0;

  return (
    <div style={s.root}>
      <audio ref={audioRef} src={SONG.audio} onEnded={() => setPlaying(false)} />

      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.songTitle}>{SONG.title}</div>
          <div style={s.songArtist}>{SONG.artist}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {micOn && <div style={s.micPill}>🎤 Mic on</div>}
          <Btn onClick={restart}>↺ Restart</Btn>
          <Btn onClick={togglePlay} primary>{playing ? "⏸ Pause" : "▶ Sing"}</Btn>
        </div>
      </div>

      {/* Progress bar */}
      <div style={s.progressTrack}>
        <div style={{ ...s.progressFill, width: `${progress}%` }} />
      </div>

      {/* Score + pitch HUD */}
      <div style={s.hud}>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>Score</div>
          <div style={{ ...s.hudValue, color: scoreColor, fontSize: 36 }}>{score}</div>
          <div style={{ color: "#6b7280", fontSize: 11 }}>{hits}/{scored} hits</div>
        </div>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>You're singing</div>
          <div style={{ ...s.hudValue, color: liveMidi ? "#60a5fa" : "#6b7280" }}>
            {midiLabel(liveMidi)}
          </div>
        </div>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>Target note</div>
          <div style={{ ...s.hudValue, color: targetMidi ? "#a78bfa" : "#6b7280" }}>
            {midiLabel(targetMidi)}
          </div>
        </div>
      </div>

      {/* Lyrics */}
      <div style={s.lyricsBox}>
        {lines.length === 0 && <div style={{ color: "#555" }}>Loading…</div>}
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast   = i < activeIdx;
          const words    = isActive ? wordsForLine(line) : null;
          return (
            <div
              key={i}
              ref={isActive ? activeLyricRef : undefined}
              style={{
                ...s.lyricLine,
                fontSize:   isActive ? 32 : 20,
                fontWeight: isActive ? 800 : 400,
                transform:  isActive ? "scale(1.05)" : "scale(1)",
                transition: "all 0.15s ease",
              }}
            >
              {isActive && words ? (
                // Word-by-word fluid wipe for the active line
                <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 10px" }}>
                  {words.map((w, wi) => {
                    const ct = audioRef.current?.currentTime ?? 0;
                    const progress = ct <= w.start ? 0
                      : ct >= w.end ? 100
                      : Math.round(((ct - w.start) / (w.end - w.start)) * 100);
                    return (
                      <span
                        key={wi}
                        style={{
                          background: `linear-gradient(to right, #facc15 ${progress}%, #9ca3af ${progress}%)`,
                          WebkitBackgroundClip: "text",
                          WebkitTextFillColor: "transparent",
                          backgroundClip: "text",
                          textShadow: "none",
                          filter: progress > 0 ? `drop-shadow(0 0 8px #facc1566)` : "none",
                          transition: "filter 0.1s",
                        }}
                      >
                        {w.word}
                      </span>
                    );
                  })}
                </span>
              ) : (
                <span style={{ color: isPast ? "#2d3748" : "#6b7280" }}>{line.text}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function noteFromMidi(midi: number) {
  const n = Math.round(midi);
  return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1);
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
  root:        { minHeight: "100vh", background: "#050505", color: "#fff", fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", padding: "20px 24px", gap: 12 },
  header:      { display: "flex", justifyContent: "space-between", alignItems: "center" },
  songTitle:   { fontSize: 22, fontWeight: 800 },
  songArtist:  { fontSize: 13, color: "#6b7280", marginTop: 2 },
  progressTrack: { height: 4, background: "#1f1f1f", borderRadius: 2, overflow: "hidden" },
  progressFill:  { height: "100%", background: "#8b5cf6", transition: "width 0.1s linear" },
  hud:         { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
  hudCard:     { background: "#111", border: "1px solid #222", borderRadius: 10, padding: "10px 14px", textAlign: "center" },
  hudLabel:    { color: "#6b7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  hudValue:    { fontSize: 20, fontWeight: 700, fontFamily: "monospace" },
  micPill:     { background: "#dc262633", color: "#f87171", border: "1px solid #f8717144", borderRadius: 20, padding: "4px 10px", fontSize: 12 },
  lyricsBox:   { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, padding: "30px 0" },
  lyricLine:   { textAlign: "center", lineHeight: 1.3, maxWidth: 640 },
};
