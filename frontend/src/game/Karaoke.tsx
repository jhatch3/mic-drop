import { useState, useEffect, useRef, useCallback } from "react";
import { PAL, FONT, bevelPanel, BevelBtn, OnAirBar, LowerThird } from "@/ui";

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
  onFinish?: (result: KaraokeResult, take?: Blob) => void;
  /** Auto-start mic + music on mount (no "Sing" click) — used when the AI host
   *  kicks off the turn. */
  autoPlay?: boolean;
}

const SR = 44100, FMIN = 65, FMAX = 1000, RMS_GATE = 0.006, CONF_MIN = 0.5;
const HIT_CENTS = 75; // widened from 50 → easier
const SMOOTH_WINDOW = 9;  // frames of median smoothing to dampen jitter (wider = steadier)
const PITCH_EMA = 0.22;   // EMA glide on the median: lower = smoother (slightly more lag)

// Median smoother with octave-jump correction. Autocorrelation pitch detection
// jumps around (especially by whole octaves); pulling each reading toward the
// recent value and taking the median kills the flicker without much lag.
function smoothPitch(hist: number[], raw: number): number {
  if (hist.length) {
    const ref = hist[hist.length - 1];
    while (raw - ref > 7) raw -= 12;   // jumped up an octave → pull down
    while (ref - raw > 7) raw += 12;   // jumped down an octave → pull up
  }
  hist.push(raw);
  if (hist.length > SMOOTH_WINDOW) hist.shift();
  const sorted = [...hist].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function noteFromMidi(midi: number) {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);
}

// YIN pitch detector (cumulative-mean-normalized difference). Far more
// octave-stable than raw autocorrelation, which is what made the meter bounce.
const YIN_THRESHOLD = 0.15;
function detectPitch(buf: Float32Array): { midi: number | null; conf: number } {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / n) < RMS_GATE) return { midi: null, conf: 0 };

  const minLag = Math.floor(SR / FMAX);
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(SR / FMIN));
  const win = n - maxLag;                 // samples compared per lag

  // 1) difference function  d(lag) = Σ (x[i] - x[i+lag])²
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < win; i++) { const diff = buf[i] - buf[i + lag]; s += diff * diff; }
    d[lag] = s;
  }
  // 2) cumulative mean normalized difference
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) { running += d[lag]; cmnd[lag] = d[lag] * lag / (running || 1); }

  // 3) first dip below threshold (→ lowest valid period, avoids octave-too-high)
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < YIN_THRESHOLD) {
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;   // settle into the local min
      best = lag; break;
    }
  }
  if (best < 0) {                          // nothing confidently periodic
    let m = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) if (cmnd[lag] < m) { m = cmnd[lag]; best = lag; }
    if (m > 0.5 || best <= 0) return { midi: null, conf: 0 };
  }
  // 4) parabolic interpolation around the dip for sub-sample precision
  let period = best;
  if (best > minLag && best < maxLag) {
    const a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) period = best + (a - c) / (2 * denom);
  }
  const conf = 1 - cmnd[best];
  if (conf < CONF_MIN) return { midi: null, conf };
  return { midi: 69 + 12 * Math.log2((SR / period) / 440), conf };
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
  ctx.fillStyle = "#0B0B0B";
  ctx.fillRect(0, 0, W, H);

  const MIDI_MIN = 48, MIDI_MAX = 84;
  const toY = (m: number) => H - ((m - MIDI_MIN) / (MIDI_MAX - MIDI_MIN)) * H;
  const toX = (t: number) => ((t - (now - win)) / win) * W;

  // Subtle grid
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m += 3) {
    const y = toY(m);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    if (NOTE_NAMES[m % 12] && !NOTE_NAMES[m % 12].includes("#")) {
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.font = "9px monospace";
      ctx.fillText(NOTE_NAMES[m % 12] + Math.floor(m / 12 - 1), 4, y - 3);
    }
  }

  // Target — magenta
  ctx.save();
  ctx.strokeStyle = "#FF1C8E"; ctx.lineWidth = 7;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  let on = false;
  for (const p of points) {
    if (!p.target) { on = false; continue; }
    const x = toX(p.t), y = toY(p.target);
    on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
  }
  ctx.stroke(); ctx.restore();

  // Singer — yellow
  ctx.save();
  ctx.strokeStyle = "#FFD400"; ctx.lineWidth = 5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath(); on = false;
  let lastSinger: { x: number; y: number } | null = null;
  for (const p of points) {
    if (!p.singer) { on = false; continue; }
    const x = toX(p.t), y = toY(p.singer);
    on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true;
    lastSinger = { x, y };
  }
  ctx.stroke(); ctx.restore();

  // Current-point dot — slime with ink stroke
  if (lastSinger) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(lastSinger.x, lastSinger.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#B6FF00";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#0B0B0B";
    ctx.stroke();
    ctx.restore();
  }
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function Karaoke({ song = DEFAULT_SONG, playerLabel, onFinish, autoPlay }: KaraokeProps = {}) {
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
  const recRef         = useRef<MediaRecorder | null>(null);   // records the take for backend scoring
  const recChunksRef   = useRef<Blob[]>([]);
  const hitsRef        = useRef(0), scoredRef = useRef(0);
  const pitchHistRef   = useRef<number[]>([]);   // recent midi for median smoothing
  const pitchEmaRef    = useRef<number | null>(null);   // EMA glide on top of the median
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
      const { midi: raw, conf } = detectPitch(buf);
      // Dampen hard: median (kills octave flicker) + an EMA glide on top (kills the small
      // frame-to-frame jitter). Reset both on silence so the next note doesn't lag/glide in.
      let midi: number | null = null;
      if (raw != null) {
        const med = smoothPitch(pitchHistRef.current, raw);
        pitchEmaRef.current = pitchEmaRef.current == null ? med : pitchEmaRef.current + PITCH_EMA * (med - pitchEmaRef.current);
        midi = pitchEmaRef.current;
      } else {
        pitchHistRef.current.length = 0;
        pitchEmaRef.current = null;
      }
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
    // Record the take so the host can score it on the backend (pitch + lyrics).
    try {
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
      recChunksRef.current = [];
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) recChunksRef.current.push(e.data); };
      rec.start(250); recRef.current = rec;
    } catch { /* recording unsupported → backend scoring falls back to pitch */ }
    setMicOn(true);
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current; if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { if (!micOn) await startMic(); await audio.play(); setPlaying(true); }
  }, [playing, micOn, startMic]);

  // Auto-start the turn (mic + music) when the AI host launches it.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!autoPlay || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try { if (!micOn) await startMic(); await audioRef.current?.play(); setPlaying(true); }
      catch { /* autoplay blocked → user taps Sing */ }
    })();
  }, [autoPlay, micOn, startMic]);

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
    const finalScore = scoredRef.current > 0
      ? Math.round(100 * hitsRef.current / scoredRef.current)
      : 0;
    const local: KaraokeResult = { score: finalScore, hits: hitsRef.current, scored: scoredRef.current };
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = () => {
        const take = new Blob(recChunksRef.current, { type: rec.mimeType || "audio/webm" });
        streamRef.current?.getTracks().forEach(t => t.stop());
        onFinish(local, take);   // hand the recorded take to the backend scorer
      };
      rec.stop();
    } else {
      streamRef.current?.getTracks().forEach(t => t.stop());
      onFinish(local);
    }
  }, [onFinish]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

  // Show active + 2 before + 3 after for context
  const visibleLines = lines.filter((_, i) =>
    i >= Math.max(0, activeIdx - 2) && i <= activeIdx + 3
  );

  // Active lyric line for the lower-third caption, with the currently-sung word
  // highlighted (broadcast karaoke caption look).
  const activeLine = activeIdx >= 0 ? lines[activeIdx] : null;
  const captionHeadline = activeLine ? (() => {
    const words = wordsForLine(activeLine);
    const activeWord = words.findIndex(w => currentTime >= w.start && currentTime < w.end);
    return (
      <span style={{ display: "flex", flexWrap: "wrap", gap: "0 6px", alignItems: "center" }}>
        {words.map((w, i) =>
          i === activeWord ? (
            <span key={i} style={{ background: PAL.yellow, border: `2px solid ${PAL.ink}`, padding: "0 6px" }}>{w.word}</span>
          ) : (
            <span key={i}>{w.word}</span>
          )
        )}
      </span>
    );
  })() : (lines.length === 0 ? "Loading lyrics…" : "…");

  return (
    <div style={{ minHeight: "100vh", background: PAL.purpleDp, color: PAL.white, fontFamily: FONT.body, display: "flex", flexDirection: "column" }}>
      <audio
        ref={audioRef}
        src={song.audio}
        onLoadedMetadata={e => setDuration((e.target as HTMLAudioElement).duration)}
        onEnded={() => { setPlaying(false); finishTurn(); }}
      />

      {/* ON-AIR top bar — broadcast style */}
      <OnAirBar
        tag={micOn ? "ON AIR" : "STANDBY"}
        tagColor={micOn ? PAL.red : PAL.cyan}
        blink={false}
        left={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT.display, fontSize: 16, color: PAL.white, letterSpacing: 0.5, textTransform: "uppercase" }}>
              {song.title}
            </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.cyan }}>{song.artist}</span>
            {playerLabel && (
              <span style={{ fontFamily: FONT.display, fontSize: 13, color: PAL.ink, background: PAL.slime, border: `2px solid ${PAL.ink}`, padding: "2px 10px", letterSpacing: 1, textTransform: "uppercase" }}>
                {playerLabel}
              </span>
            )}
          </span>
        }
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {micOn && <span style={{ color: PAL.red, fontFamily: FONT.display }}>● REC</span>}
            <span>{fmt(currentTime)} / {fmt(duration)}</span>
          </span>
        }
      />

      {/* Progress bar */}
      <div style={{ height: 6, background: PAL.ink, borderBottom: `2px solid ${PAL.ink}` }}>
        <div style={{ height: "100%", width: `${progress}%`, background: PAL.slime, transition: "width 0.1s linear" }} />
      </div>

      {/* Main content: lyrics left, graph + stats right */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr minmax(300px, 400px)", gap: 0 }}>

        {/* Lyrics panel */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 48px", gap: 20, borderRight: `4px solid ${PAL.ink}`, minHeight: 400, background: `radial-gradient(circle at 50% 24%, ${PAL.purple} 0%, ${PAL.purpleDp} 72%)` }}>
          {lines.length === 0 && <div style={{ fontFamily: FONT.mono, fontSize: 18, color: PAL.cyan, letterSpacing: 1 }}>Loading lyrics…</div>}
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
                  fontFamily: FONT.display,
                  fontSize:   isActive ? 40 : 21,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: isActive ? PAL.white : PAL.cream,
                  textShadow: isActive ? `3px 3px 0 ${PAL.ink}` : "none",
                  opacity:    isActive ? 1 : isPast ? 0.25 : 0.5,
                  transform:  isActive ? "scale(1.02)" : "scale(1)",
                  transition: "all 0.2s ease",
                  maxWidth: 540,
                  lineHeight: 1.2,
                }}
              >
                {isActive && words ? (
                  <span style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "4px 10px" }}>
                    {words.map((w, wi) => {
                      const sung = currentTime >= w.start;
                      const cur  = currentTime >= w.start && currentTime < w.end;
                      return (
                        <span key={wi} style={{
                          color: cur ? PAL.ink : sung ? PAL.yellow : PAL.cream,
                          background: cur ? PAL.yellow : "transparent",
                          border: cur ? `2px solid ${PAL.ink}` : "2px solid transparent",
                          padding: "0 6px",
                        }}>
                          {w.word}
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
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "20px", background: PAL.purpleDp }}>

          {/* Pitch graph — ink frame + offset shadow + Anton legend chips */}
          <div style={{ ...bevelPanel(PAL.ink, { bw: 4, shadow: 6 }), position: "relative", overflow: "hidden" }}>
            <canvas ref={canvasRef} width={680} height={200} style={{ width: "100%", height: 200, display: "block" }} />
            <div style={{ position: "absolute", top: 8, left: 10, display: "flex", gap: 8 }}>
              {([["● TARGET", PAL.magenta], ["● YOU", PAL.yellow]] as const).map(([label, c]) => (
                <span key={label} style={{ fontFamily: FONT.display, fontSize: 13, color: PAL.ink, background: c, padding: "2px 8px", border: `2px solid ${PAL.ink}`, letterSpacing: 0.5 }}>
                  {label}
                </span>
              ))}
            </div>
            {!playing && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(11,11,11,0.86)", color: PAL.cyan, fontFamily: FONT.mono, fontSize: 18, letterSpacing: 2, textTransform: "uppercase" }}>
                Pitch Meter
              </div>
            )}
          </div>

          {/* Live lyric caption — what to sing RIGHT NOW, directly under the pitch meter */}
          <div style={{ ...bevelPanel(PAL.ink, { bw: 3, shadow: 4 }), color: PAL.white, padding: "10px 12px", minHeight: 48, display: "flex", alignItems: "center", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <span style={{ background: PAL.magenta, color: PAL.white, fontFamily: FONT.display, fontSize: 12, letterSpacing: 1, padding: "2px 8px", flexShrink: 0 }}>♪ SING</span>
            <span style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: "clamp(15px,2.4vw,20px)", lineHeight: 1.15 }}>{captionHeadline}</span>
          </div>

          {/* Live score — slime bevel panel */}
          <div style={{ ...bevelPanel(PAL.slime), padding: "12px 14px", textAlign: "center", color: PAL.ink }}>
            <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: 2, textTransform: "uppercase" }}>Live Score</div>
            <div style={{ fontFamily: FONT.display, fontSize: 64, lineHeight: 0.9, textShadow: `3px 3px 0 ${PAL.white}` }}>{score}</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 16 }}>{hits} / {scored} hit</div>
          </div>

          {/* Note chips: YOU / TGT */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div style={{ ...bevelPanel(PAL.white, { shadow: 0 }), padding: "8px", textAlign: "center", color: PAL.ink }}>
              <div style={{ fontFamily: FONT.display, fontSize: 12, letterSpacing: 1, color: PAL.purpleDp, textTransform: "uppercase" }}>You</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 28, color: liveMidi ? PAL.yellow : PAL.purpleDp, WebkitTextStroke: `1px ${PAL.ink}`, lineHeight: 1 }}>
                {liveMidi ? noteFromMidi(liveMidi) : "—"}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.purpleDp }}>{liveMidi ? `${liveMidi.toFixed(1)} midi` : "silent"}</div>
            </div>
            <div style={{ ...bevelPanel(PAL.white, { shadow: 0 }), padding: "8px", textAlign: "center", color: PAL.ink }}>
              <div style={{ fontFamily: FONT.display, fontSize: 12, letterSpacing: 1, color: PAL.purpleDp, textTransform: "uppercase" }}>Tgt</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 28, color: targetMidi ? PAL.magenta : PAL.purpleDp, WebkitTextStroke: `1px ${PAL.ink}`, lineHeight: 1 }}>
                {targetMidi ? noteFromMidi(targetMidi) : "—"}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.purpleDp }}>{targetMidi ? `${targetMidi.toFixed(1)} midi` : "rest"}</div>
            </div>
          </div>

          {/* Tuner — cents off indicator */}
          <div style={{ ...bevelPanel(PAL.white, { shadow: 0 }), padding: "12px 16px", color: PAL.ink }}>
            <div style={{ fontFamily: FONT.display, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8, color: PAL.purpleDp }}>Pitch Accuracy</div>
            <div style={{ position: "relative", height: 10, background: PAL.ink, border: `2px solid ${PAL.ink}`, overflow: "visible" }}>
              {/* Center marker */}
              <div style={{ position: "absolute", left: "50%", top: -4, width: 2, height: 18, background: PAL.purpleDp, transform: "translateX(-50%)" }} />
              {/* Hit zone */}
              <div style={{ position: "absolute", left: `${50 - (HIT_CENTS / 200) * 100}%`, width: `${(HIT_CENTS / 100) * 100}%`, height: "100%", background: `${PAL.slime}55` }} />
              {/* Cursor */}
              {centsOff !== null && (
                <div style={{
                  position: "absolute",
                  left: `${Math.min(98, Math.max(2, 50 + (centsOff / 200) * 100))}%`,
                  top: "50%", transform: "translate(-50%, -50%)",
                  width: 14, height: 14,
                  background: Math.abs(centsOff) <= HIT_CENTS ? PAL.slime : PAL.red,
                  border: `2px solid ${PAL.ink}`,
                  transition: "left 0.05s, background 0.1s",
                }} />
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: FONT.mono, fontSize: 14, color: PAL.purpleDp }}>
              <span>♭ flat</span>
              <span style={{ color: centsOff !== null ? (Math.abs(centsOff) <= HIT_CENTS ? PAL.slimeDk : PAL.red) : PAL.purpleDp, fontWeight: 700 }}>
                {centsOff !== null ? `${centsOff > 0 ? "+" : ""}${Math.round(centsOff)}¢` : "—"}
              </span>
              <span>sharp ♯</span>
            </div>
          </div>

          {/* Manual controls (only outside autonomous AI-host mode) */}
          {!autoPlay && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <BevelBtn color={PAL.white} fg={PAL.ink} onClick={restart} style={{ minHeight: 44 }}>↺ Restart</BevelBtn>
              <BevelBtn color={playing ? PAL.orange : PAL.slime} fg={PAL.ink} onClick={togglePlay} style={{ minHeight: 44, flex: 1 }}>
                {playing ? "⏸ Pause" : "▶ Sing »"}
              </BevelBtn>
              {onFinish && (
                <BevelBtn color={PAL.magenta} fg={PAL.white} onClick={finishTurn} style={{ minHeight: 44 }}>Finish »</BevelBtn>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Lyric caption — the signature lower-third */}
      <LowerThird
        kicker="♪ LIVE"
        kickerColor={PAL.red}
        kickerFg={PAL.white}
        headline={captionHeadline}
        action={!autoPlay && onFinish ? <BevelBtn color={PAL.orange} fg={PAL.white} onClick={finishTurn} style={{ minHeight: 44 }}>END TURN »</BevelBtn> : undefined}
      />
    </div>
  );
}
