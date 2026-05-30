import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LyricLine { t: number; end: number; text: string; }
interface ContourFrame { t: number; midi: number | null; voiced: boolean; }
interface Word { word: string; start: number; end: number; }

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

// ─── Pitch detection ──────────────────────────────────────────────────────────
const SR = 44100;
const FMIN = 65;
const FMAX = 1000;
const RMS_GATE = 0.003;
const CONF_MIN = 0.5;

function detectPitch(buf: Float32Array): { midi: number | null; conf: number } {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < RMS_GATE) return { midi: null, conf: 0 };
  const minLag = Math.floor(SR / FMAX);
  const maxLag = Math.min(n - 1, Math.floor(SR / FMIN));
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
  return { midi: 69 + 12 * Math.log2((SR / best) / 440), conf };
}

function centsError(singer: number, target: number) {
  const diff = singer - target;
  return (diff - 12 * Math.round(diff / 12)) * 100;
}

// ─── Pitch graph ──────────────────────────────────────────────────────────────
function drawGraph(
  canvas: HTMLCanvasElement | null,
  points: { t: number; target: number | null; singer: number | null }[],
  now: number,
  win: number,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = "#080810";
  ctx.fillRect(0, 0, W, H);

  const MIDI_MIN = 48, MIDI_MAX = 84;
  const midiToY = (m: number) => H - ((m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN)) * H;
  const tToX    = (t: number) => ((t - (now - win)) / win) * W;

  // Grid
  ctx.strokeStyle = "#ffffff08";
  ctx.lineWidth = 1;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 3) {
    const y = midiToY(m);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    // Note labels
    const name = NOTE_NAMES[m % 12];
    if (name && !name.includes("#")) {
      ctx.fillStyle = "#ffffff18";
      ctx.font = "10px monospace";
      ctx.fillText(name + Math.floor(m / 12 - 1), 4, y - 2);
    }
  }

  // Target — thick glowing purple
  ctx.save();
  ctx.shadowColor = "#a78bfa88";
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let started = false;
  for (const p of points) {
    if (p.target === null) { started = false; continue; }
    const x = tToX(p.t), y = midiToY(p.target);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Singer — glowing yellow
  ctx.save();
  ctx.shadowColor = "#facc1588";
  ctx.shadowBlur = 10;
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  started = false;
  for (const p of points) {
    if (p.singer === null) { started = false; continue; }
    const x = tToX(p.t), y = midiToY(p.singer);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Legend
  ctx.font = "bold 11px system-ui";
  ctx.fillStyle = "#a78bfa"; ctx.fillText("● Target", 10, H - 20);
  ctx.fillStyle = "#facc15"; ctx.fillText("● You",    10, H - 6);
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Karaoke() {
  const [lines, setLines]         = useState<LyricLine[]>([]);
  const [contour, setContour]     = useState<ContourFrame[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [playing, setPlaying]     = useState(false);
  const [micOn, setMicOn]         = useState(false);
  const [score, setScore]         = useState(0);
  const [hits, setHits]           = useState(0);
  const [scored, setScored]       = useState(0);
  const [liveMidi, setLiveMidi]   = useState<number | null>(null);
  const [targetMidi, setTargetMidi] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const audioRef      = useRef<HTMLAudioElement>(null);
  const rafRef        = useRef<number>(0);
  const activeLyricRef = useRef<HTMLDivElement>(null);
  const ctxRef        = useRef<AudioContext | null>(null);
  const analyserRef   = useRef<AnalyserNode | null>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const hitsRef       = useRef(0);
  const scoredRef     = useRef(0);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const graphRef      = useRef<{ t: number; target: number | null; singer: number | null }[]>([]);
  const GRAPH_WIN     = 6;

  useEffect(() => {
    fetch(SONG.lyrics).then(r => r.json()).then(d => setLines(d.lines));
    fetch(SONG.contour).then(r => r.json()).then(d => setContour(d.frames));
  }, []);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    setCurrentTime(t);
    setActiveIdx(() => {
      const idx = lines.findIndex(l => t >= l.t && t < l.end);
      return idx === -1 ? -1 : idx;
    });

    if (analyserRef.current && contour.length > 0) {
      const buf = new Float32Array(analyserRef.current.fftSize);
      analyserRef.current.getFloatTimeDomainData(buf);
      const { midi, conf } = detectPitch(buf);
      setLiveMidi(midi);

      const target = contour.find(f => f.voiced && f.midi !== null && Math.abs(f.t - t) <= 0.03) ?? null;
      setTargetMidi(target?.midi ?? null);

      if (target?.midi != null) {
        scoredRef.current++;
        if (midi !== null && conf >= CONF_MIN && Math.abs(centsError(midi, target.midi)) <= 50) {
          hitsRef.current++;
        }
        setHits(hitsRef.current);
        setScored(scoredRef.current);
        setScore(Math.round(100 * hitsRef.current / scoredRef.current));
      }

      graphRef.current.push({ t, target: target?.midi ?? null, singer: midi });
      graphRef.current = graphRef.current.filter(p => p.t >= t - GRAPH_WIN);
      drawGraph(canvasRef.current, graphRef.current, t, GRAPH_WIN);
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [lines, contour]);

  useEffect(() => {
    if (playing) rafRef.current = requestAnimationFrame(tick);
    else cancelAnimationFrame(rafRef.current);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, tick]);

  useEffect(() => {
    activeLyricRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    streamRef.current = stream;
    const ctx = new AudioContext({ sampleRate: SR });
    ctxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const an  = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    analyserRef.current = an;
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
    if (playing) { audio.pause(); setPlaying(false); }
    else {
      if (!micOn) await startMic();
      await audio.play();
      setPlaying(true);
    }
  }, [playing, micOn, startMic]);

  const restart = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    hitsRef.current = 0; scoredRef.current = 0;
    graphRef.current = [];
    setHits(0); setScored(0); setScore(0); setActiveIdx(-1); setCurrentTime(0);
    if (!micOn) await startMic();
    await audio.play();
    setPlaying(true);
  }, [micOn, startMic]);

  useEffect(() => () => { stopMic(); cancelAnimationFrame(rafRef.current); }, [stopMic]);

  const scoreColor = score >= 80 ? "#4ade80" : score >= 50 ? "#facc15" : "#f87171";
  const audio = audioRef.current;
  const progress = audio?.duration ? (currentTime / audio.duration) * 100 : 0;

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
          {micOn && <span style={s.micPill}>🎤 Live</span>}
          <button onClick={restart} style={s.btnGhost}>↺</button>
          <button onClick={togglePlay} style={s.btnPrimary}>
            {playing ? "⏸ Pause" : "▶ Sing"}
          </button>
        </div>
      </div>

      {/* Progress */}
      <div style={s.progressTrack}>
        <div style={{ ...s.progressFill, width: `${progress}%` }} />
      </div>

      {/* HUD */}
      <div style={s.hud}>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>Score</div>
          <div style={{ fontSize: 42, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{score}</div>
          <div style={{ color: "#4b5563", fontSize: 11, marginTop: 2 }}>{hits}/{scored} hits</div>
        </div>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>You</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: liveMidi ? "#facc15" : "#374151", fontFamily: "monospace" }}>
            {liveMidi ? noteFromMidi(liveMidi) : "—"}
          </div>
          <div style={{ color: "#4b5563", fontSize: 11 }}>{liveMidi ? liveMidi.toFixed(1) : "silent"}</div>
        </div>
        <div style={s.hudCard}>
          <div style={s.hudLabel}>Target</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: targetMidi ? "#a78bfa" : "#374151", fontFamily: "monospace" }}>
            {targetMidi ? noteFromMidi(targetMidi) : "—"}
          </div>
          <div style={{ color: "#4b5563", fontSize: 11 }}>{targetMidi ? targetMidi.toFixed(1) : "rest"}</div>
        </div>
      </div>

      {/* Pitch graph */}
      <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid #1a1a1a" }}>
        <canvas ref={canvasRef} width={900} height={160} style={{ width: "100%", height: 160, display: "block" }} />
        {!playing && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#080810cc", color: "#4b5563", fontSize: 13, letterSpacing: 1 }}>
            PITCH GRAPH — press Sing to begin
          </div>
        )}
      </div>

      {/* Lyrics */}
      <div style={s.lyricsBox}>
        {lines.length === 0 && <div style={{ color: "#374151" }}>Loading…</div>}
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast   = i < activeIdx;
          const words    = isActive ? wordsForLine(line) : null;
          return (
            <div
              key={i}
              ref={isActive ? activeLyricRef : undefined}
              style={{
                textAlign: "center",
                fontSize:   isActive ? 34 : isPast ? 18 : 20,
                fontWeight: isActive ? 800 : 400,
                transform:  isActive ? "scale(1.04)" : "scale(1)",
                transition: "all 0.2s ease",
                maxWidth: 680,
                lineHeight: 1.2,
              }}
            >
              {isActive && words ? (
                <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 12px" }}>
                  {words.map((w, wi) => {
                    const ct = currentTime;
                    const pct = ct <= w.start ? 0 : ct >= w.end ? 100
                      : Math.round(((ct - w.start) / (w.end - w.start)) * 100);
                    return (
                      // Double-span overlay: gray base, gold clip on top
                      <span key={wi} style={{ position: "relative", display: "inline-block", color: "#6b7280" }}>
                        {w.word}
                        <span style={{
                          position: "absolute", left: 0, top: 0,
                          color: "#facc15",
                          overflow: "hidden",
                          width: `${pct}%`,
                          whiteSpace: "nowrap",
                          textShadow: "0 0 12px #facc1566",
                        }}>
                          {w.word}
                        </span>
                      </span>
                    );
                  })}
                </span>
              ) : (
                <span style={{ color: isPast ? "#1f2937" : "#4b5563" }}>{line.text}</span>
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
  return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);
}

const s: Record<string, React.CSSProperties> = {
  root:          { minHeight: "100vh", background: "#030308", color: "#fff", fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", padding: "20px 28px", gap: 14 },
  header:        { display: "flex", justifyContent: "space-between", alignItems: "center" },
  songTitle:     { fontSize: 24, fontWeight: 900, letterSpacing: -0.5 },
  songArtist:    { fontSize: 13, color: "#4b5563", marginTop: 3 },
  progressTrack: { height: 3, background: "#111", borderRadius: 2, overflow: "hidden" },
  progressFill:  { height: "100%", background: "linear-gradient(to right, #7c3aed, #a78bfa)", transition: "width 0.1s linear" },
  hud:           { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 },
  hudCard:       { background: "#0d0d18", border: "1px solid #1a1a2e", borderRadius: 12, padding: "12px 16px", textAlign: "center" },
  hudLabel:      { color: "#374151", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: 2, marginBottom: 6 },
  micPill:       { background: "#dc262622", color: "#f87171", border: "1px solid #f8717133", borderRadius: 20, padding: "4px 12px", fontSize: 12 },
  btnPrimary:    { background: "linear-gradient(135deg, #7c3aed, #8b5cf6)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 22px", cursor: "pointer", fontSize: 15, fontWeight: 700 },
  btnGhost:      { background: "transparent", color: "#6b7280", border: "1px solid #1f2937", borderRadius: 10, padding: "10px 16px", cursor: "pointer", fontSize: 16 },
  lyricsBox:     { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 22, padding: "40px 0 60px" },
};
