import { useState, useEffect, useRef, useCallback } from "react";

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

export interface SongDef {
  audio:   string;
  lyrics:  string;
  contour: string;
  title:   string;
  artist:  string;
}

export const DEFAULT_SONG: SongDef = {
  audio:   "/songs/firework/instrumental.mp3",
  lyrics:  "/songs/firework/lyrics.json",
  contour: "/songs/firework/contour.json",
  title:   "Firework",
  artist:  "Katy Perry",
};

export interface KaraokeResult { score: number; hits: number; scored: number; }

interface KaraokeProps {
  /** Song to sing. Defaults to Firework. */
  song?: SongDef;
  /** Optional player badge shown in the top bar (e.g. "Player 1"). */
  playerLabel?: string;
  /** When provided, the component runs in "turn" mode: finishing the song (or
   *  pressing "Finish turn") fires this with the final score instead of just
   *  stopping playback. Used by the local hot-seat 2-player game. */
  onFinish?: (result: KaraokeResult) => void;
}

const SR = 44100, FMIN = 65, FMAX = 1000, RMS_GATE = 0.002, CONF_MIN = 0.4;
const HIT_CENTS = 75; // widened from 50 → easier
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function noteFromMidi(midi: number) {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);
}

function detectPitch(buf: Float32Array): { midi: number | null; conf: number } {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / n) < RMS_GATE) return { midi: null, conf: 0 };
  const minLag = Math.floor(SR / FMAX), maxLag = Math.min(n - 1, Math.floor(SR / FMIN));
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

function drawGraph(
  canvas: HTMLCanvasElement | null,
  points: { t: number; target: number | null; singer: number | null }[],
  now: number, win: number,
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#07070f";
  ctx.fillRect(0, 0, W, H);

  const MIDI_MIN = 48, MIDI_MAX = 84;
  const toY = (m: number) => H - ((m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN)) * H;
  const toX = (t: number) => ((t - (now - win)) / win) * W;

  // Subtle grid
  ctx.strokeStyle = "#ffffff06";
  ctx.lineWidth = 1;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 3) {
    const y = toY(m);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    if (NOTE_NAMES[m % 12] && !NOTE_NAMES[m % 12].includes("#")) {
      ctx.fillStyle = "#ffffff15";
      ctx.font = "9px monospace";
      ctx.fillText(NOTE_NAMES[m % 12] + Math.floor(m / 12 - 1), 4, y - 3);
    }
  }

  // Target — purple glow
  ctx.save();
  ctx.shadowColor = "#a78bfa"; ctx.shadowBlur = 12;
  ctx.strokeStyle = "#a78bfa"; ctx.lineWidth = 3;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  let on = false;
  for (const p of points) {
    if (!p.target) { on = false; continue; }
    const x = toX(p.t), y = toY(p.target);
    on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
  }
  ctx.stroke(); ctx.restore();

  // Singer — yellow glow
  ctx.save();
  ctx.shadowColor = "#facc15"; ctx.shadowBlur = 14;
  ctx.strokeStyle = "#facc15"; ctx.lineWidth = 2.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath(); on = false;
  for (const p of points) {
    if (!p.singer) { on = false; continue; }
    const x = toX(p.t), y = toY(p.singer);
    on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
  }
  ctx.stroke(); ctx.restore();

  // Legend pills
  const pill = (label: string, color: string, x: number) => {
    ctx.font = "bold 10px system-ui";
    const w = ctx.measureText(label).width + 16;
    ctx.fillStyle = color + "22";
    ctx.beginPath();
    ctx.roundRect(x, H - 22, w, 16, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(label, x + 8, H - 11);
  };
  pill("● Target", "#a78bfa", 8);
  pill("● You",    "#facc15", 90);
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Karaoke({ song = DEFAULT_SONG, playerLabel, onFinish }: KaraokeProps = {}) {
  const [lines, setLines]           = useState<LyricLine[]>([]);
  const [contour, setContour]       = useState<ContourFrame[]>([]);
  const [activeIdx, setActiveIdx]   = useState(-1);
  const [playing, setPlaying]       = useState(false);
  const [micOn, setMicOn]           = useState(false);
  const [score, setScore]           = useState(0);
  const [hits, setHits]             = useState(0);
  const [scored, setScored]         = useState(0);
  const [liveMidi, setLiveMidi]     = useState<number | null>(null);
  const [targetMidi, setTargetMidi] = useState<number | null>(null);
  const [centsOff, setCentsOff]     = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration]     = useState(0);

  const audioRef       = useRef<HTMLAudioElement>(null);
  const rafRef         = useRef<number>(0);
  const activeLyricRef = useRef<HTMLDivElement>(null);
  const ctxRef         = useRef<AudioContext | null>(null);
  const analyserRef    = useRef<AnalyserNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const hitsRef        = useRef(0), scoredRef = useRef(0);
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const graphRef       = useRef<{ t: number; target: number | null; singer: number | null }[]>([]);

  useEffect(() => {
    fetch(song.lyrics).then(r => r.json()).then(d => setLines(d.lines));
    fetch(song.contour).then(r => r.json()).then(d => setContour(d.frames));
  }, [song.lyrics, song.contour]);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime;
    setCurrentTime(t);
    setActiveIdx(lines.findIndex(l => t >= l.t && t < l.end));

    if (analyserRef.current && contour.length > 0) {
      const buf = new Float32Array(analyserRef.current.fftSize);
      analyserRef.current.getFloatTimeDomainData(buf);
      const { midi, conf } = detectPitch(buf);
      setLiveMidi(midi);
      const target = contour.find(f => f.voiced && f.midi !== null && Math.abs(f.t - t) <= 0.03) ?? null;
      setTargetMidi(target?.midi ?? null);
      if (target?.midi != null) {
        scoredRef.current++;
        const cents = midi ? centsError(midi, target.midi) : null;
        setCentsOff(cents);
        if (midi && conf >= CONF_MIN && cents !== null && Math.abs(cents) <= HIT_CENTS) hitsRef.current++;
        setHits(hitsRef.current); setScored(scoredRef.current);
        setScore(Math.round(100 * hitsRef.current / scoredRef.current));
      } else {
        setCentsOff(null);
      }
      graphRef.current.push({ t, target: target?.midi ?? null, singer: midi });
      graphRef.current = graphRef.current.filter(p => p.t >= t - 6);
      drawGraph(canvasRef.current, graphRef.current, t, 6);
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
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    src.connect(an); analyserRef.current = an;
    setMicOn(true);
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current; if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { if (!micOn) await startMic(); await audio.play(); setPlaying(true); }
  }, [playing, micOn, startMic]);

  const restart = useCallback(async () => {
    const audio = audioRef.current; if (!audio) return;
    audio.currentTime = 0;
    hitsRef.current = 0; scoredRef.current = 0; graphRef.current = [];
    setHits(0); setScored(0); setScore(0); setActiveIdx(-1); setCurrentTime(0);
    if (!micOn) await startMic();
    await audio.play(); setPlaying(true);
  }, [micOn, startMic]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    ctxRef.current?.close();
    cancelAnimationFrame(rafRef.current);
  }, []);

  // Turn mode: hand the final score back to the orchestrator and release the mic.
  // Guarded so the natural song-end + a manual "Finish turn" can't double-fire.
  const finishedRef = useRef(false);
  const finishTurn = useCallback(() => {
    if (!onFinish || finishedRef.current) return;
    finishedRef.current = true;
    const audio = audioRef.current;
    if (audio) audio.pause();
    setPlaying(false);
    streamRef.current?.getTracks().forEach(t => t.stop());
    const finalScore = scoredRef.current > 0
      ? Math.round(100 * hitsRef.current / scoredRef.current)
      : 0;
    onFinish({ score: finalScore, hits: hitsRef.current, scored: scoredRef.current });
  }, [onFinish]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const scoreColor = score >= 80 ? "#4ade80" : score >= 50 ? "#facc15" : "#f87171";
  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

  // Show active + 2 before + 3 after for context
  const visibleLines = lines.filter((_, i) =>
    i >= Math.max(0, activeIdx - 2) && i <= activeIdx + 3
  );

  return (
    <div style={{ minHeight: "100vh", background: "#07070f", color: "#fff", fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <audio
        ref={audioRef}
        src={song.audio}
        onLoadedMetadata={e => setDuration((e.target as HTMLAudioElement).duration)}
        onEnded={() => { setPlaying(false); finishTurn(); }}
      />

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", borderBottom: "1px solid #0f0f1a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg,#7c3aed,#4f46e5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎤</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{song.title}</div>
            <div style={{ color: "#4b5563", fontSize: 12 }}>{song.artist}</div>
          </div>
          {playerLabel && (
            <div style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: "#a78bfa", background: "#a78bfa1a", border: "1px solid #a78bfa40", borderRadius: 20, padding: "4px 12px" }}>
              {playerLabel}
            </div>
          )}
        </div>

        {/* Score badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {micOn && <div style={{ fontSize: 11, color: "#f87171", background: "#f8717115", border: "1px solid #f8717130", borderRadius: 20, padding: "3px 10px" }}>● REC</div>}
          <button onClick={restart} style={{ background: "transparent", border: "1px solid #1f2937", borderRadius: 10, color: "#6b7280", padding: "8px 14px", cursor: "pointer", fontSize: 18 }}>↺</button>
          <button onClick={togglePlay} style={{ background: playing ? "#1f2937" : "linear-gradient(135deg,#7c3aed,#6d28d9)", border: "none", borderRadius: 10, color: "#fff", padding: "10px 22px", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>
            {playing ? "⏸ Pause" : "▶ Sing"}
          </button>
          {onFinish && (
            <button onClick={finishTurn} style={{ background: "linear-gradient(135deg,#16a34a,#15803d)", border: "none", borderRadius: 10, color: "#fff", padding: "10px 18px", cursor: "pointer", fontWeight: 700, fontSize: 14 }}>
              Finish turn →
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 2, background: "#0f0f1a" }}>
        <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(to right, #7c3aed, #a78bfa)", transition: "width 0.1s linear" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 24px", fontSize: 10, color: "#374151", fontFamily: "monospace" }}>
        <span>{fmt(currentTime)}</span>
        <span>{fmt(duration)}</span>
      </div>

      {/* Main content: lyrics left, graph + stats right */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 380px", gap: 0 }}>

        {/* Lyrics panel */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 48px", gap: 20, borderRight: "1px solid #0f0f1a", minHeight: 400 }}>
          {lines.length === 0 && <div style={{ color: "#1f2937" }}>Loading…</div>}
          {visibleLines.map((line) => {
            const i = lines.indexOf(line);
            const isActive = i === activeIdx;
            const isPast   = i < activeIdx;
            const words    = isActive ? wordsForLine(line) : null;
            return (
              <div
                key={i}
                ref={isActive ? activeLyricRef : undefined}
                style={{
                  textAlign: "center",
                  fontSize:   isActive ? 36 : 19,
                  fontWeight: isActive ? 800 : 400,
                  opacity:    isActive ? 1 : isPast ? 0.2 : 0.45,
                  transform:  isActive ? "scale(1.02)" : "scale(1)",
                  transition: "all 0.2s ease",
                  maxWidth: 540,
                  lineHeight: 1.25,
                }}
              >
                {isActive && words ? (
                  <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0 10px" }}>
                    {words.map((w, wi) => {
                      const pct = currentTime <= w.start ? 0 : currentTime >= w.end ? 100
                        : Math.round(((currentTime - w.start) / (w.end - w.start)) * 100);
                      return (
                        <span key={wi} style={{ position: "relative", display: "inline-block", color: "#374151" }}>
                          {w.word}
                          <span style={{ position: "absolute", left: 0, top: 0, color: "#facc15", overflow: "hidden", width: `${pct}%`, whiteSpace: "nowrap", textShadow: "0 0 16px #facc1580" }}>
                            {w.word}
                          </span>
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  line.text
                )}
              </div>
            );
          })}
        </div>

        {/* Right panel: graph + note stats */}
        <div style={{ display: "flex", flexDirection: "column", gap: 0, padding: "20px 20px", background: "#060610" }}>

          {/* Pitch graph */}
          <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #0f0f1a", position: "relative" }}>
            <canvas ref={canvasRef} width={680} height={200} style={{ width: "100%", height: 200, display: "block" }} />
            {!playing && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#07070fee", color: "#1f2937", fontSize: 12, letterSpacing: 2, textTransform: "uppercase" }}>
                Pitch Graph
              </div>
            )}
          </div>

          {/* Live score — big */}
          <div style={{ background: "#0a0a18", border: "1px solid #0f0f1a", borderRadius: 12, padding: "16px", marginTop: 12, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#374151", letterSpacing: 3, textTransform: "uppercase", marginBottom: 4 }}>Live Score</div>
            <div style={{ fontSize: 72, fontWeight: 900, color: scoreColor, lineHeight: 1, transition: "color 0.3s" }}>{score}</div>
            <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>{hits} / {scored} frames hit</div>
            {/* Accuracy bar */}
            <div style={{ height: 5, background: "#111", borderRadius: 3, overflow: "hidden", marginTop: 10 }}>
              <div style={{ height: "100%", width: `${score}%`, background: `linear-gradient(to right, #7c3aed, ${scoreColor})`, borderRadius: 3, transition: "width 0.2s ease" }} />
            </div>
          </div>

          {/* Note + tuner */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <div style={{ background: "#0a0a18", border: "1px solid #0f0f1a", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "#374151", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>You</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: liveMidi ? "#facc15" : "#1f2937", fontFamily: "monospace", lineHeight: 1 }}>
                {liveMidi ? noteFromMidi(liveMidi) : "—"}
              </div>
              <div style={{ fontSize: 11, color: "#374151", marginTop: 4 }}>{liveMidi ? `${liveMidi.toFixed(1)} midi` : "silent"}</div>
            </div>
            <div style={{ background: "#0a0a18", border: "1px solid #0f0f1a", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "#374151", letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Target</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: targetMidi ? "#a78bfa" : "#1f2937", fontFamily: "monospace", lineHeight: 1 }}>
                {targetMidi ? noteFromMidi(targetMidi) : "—"}
              </div>
              <div style={{ fontSize: 11, color: "#374151", marginTop: 4 }}>{targetMidi ? `${targetMidi.toFixed(1)} midi` : "rest"}</div>
            </div>
          </div>

          {/* Tuner — cents off indicator */}
          <div style={{ background: "#0a0a18", border: "1px solid #0f0f1a", borderRadius: 10, padding: "12px 16px", marginTop: 10 }}>
            <div style={{ fontSize: 10, color: "#374151", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Pitch Accuracy</div>
            <div style={{ position: "relative", height: 8, background: "#111", borderRadius: 4, overflow: "visible" }}>
              {/* Zone markers */}
              <div style={{ position: "absolute", left: "50%", top: -3, width: 2, height: 14, background: "#1f2937", transform: "translateX(-50%)" }} />
              {/* Green hit zone */}
              <div style={{ position: "absolute", left: `${50 - (HIT_CENTS / 200) * 100}%`, width: `${(HIT_CENTS / 100) * 100}%`, height: "100%", background: "#4ade8022", borderRadius: 4 }} />
              {/* Cursor */}
              {centsOff !== null && (
                <div style={{
                  position: "absolute",
                  left: `${Math.min(98, Math.max(2, 50 + (centsOff / 200) * 100))}%`,
                  top: "50%", transform: "translate(-50%, -50%)",
                  width: 12, height: 12, borderRadius: "50%",
                  background: Math.abs(centsOff) <= HIT_CENTS ? "#4ade80" : "#f87171",
                  boxShadow: `0 0 8px ${Math.abs(centsOff) <= HIT_CENTS ? "#4ade80" : "#f87171"}`,
                  transition: "left 0.05s, background 0.1s",
                }} />
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 10, color: "#1f2937" }}>
              <span>♭ flat</span>
              <span style={{ color: centsOff !== null ? (Math.abs(centsOff) <= HIT_CENTS ? "#4ade80" : "#f87171") : "#1f2937", fontWeight: 600 }}>
                {centsOff !== null ? `${centsOff > 0 ? "+" : ""}${Math.round(centsOff)}¢` : "—"}
              </span>
              <span>sharp ♯</span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
