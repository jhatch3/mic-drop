import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live AI game-show host for the real /host game.
 *
 *   /ws/host (Gemini Live)  ──▶  host voice (PCM24) + SFX  ──▶  speakers   (+ closed captions)
 *   browser speech-to-text  ──▶  your reply  ──▶  host       (tool calls drive the game)
 *
 * Flow: connect() → host greets + asks "ready?" → auto-listens → you say "yes" → host calls
 * start_game (onCommand) → game starts. Captions are exposed as `hostCaption` / `youCaption`.
 */
type Command = "start_game" | "start_p1_turn" | "start_p2_turn" | "end_game" | "reveal_scores";
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export function useVoiceHost(opts: {
  onCommand: (cmd: Command) => void;
  /** Fires when the host finishes a spoken turn. Return true to suppress auto-listen
   *  (e.g. we're about to start a turn, so don't re-open the mic). */
  onTurnComplete?: () => boolean | void;
  /** "karaoke" (default) or "dance" — tells the backend which game the host is hosting. */
  gamemode?: string;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const playRef = useRef<AudioContext | null>(null);
  const nextRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());   // live audio nodes, for flushAudio()
  const captionTimersRef = useRef<any[]>([]);   // pending delayed-caption timers, cancelled on flush
  const captionAnchorRef = useRef(0);           // AudioContext time when the current pass's audio starts
  const awaitingAnchorRef = useRef(false);      // set on audio_anchor; captured at the next playPCM
  const recogRef = useRef<any>(null);
  const autoListenRef = useRef(true);
  const listeningRef = useRef(false);          // mirror of `listening` for use in closures
  const armTimerRef = useRef<any>(null);        // pending "open mic once host is quiet" timer
  const expectReplyRef = useRef(false);         // host asked something → keep mic open until they answer
  const gotFinalRef = useRef(false);            // did the current recognition produce a final result
  const armRef = useRef<() => void>(() => {});  // forward ref to armListenWhenQuiet
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [hostCaption, setHostCaption] = useState("");
  const [youCaption, setYouCaption] = useState("");
  const onCommandRef = useRef(opts.onCommand);
  onCommandRef.current = opts.onCommand;
  const onTurnCompleteRef = useRef(opts.onTurnComplete);
  onTurnCompleteRef.current = opts.onTurnComplete;

  // ── host audio + SFX (shared timeline so they never overlap) ──
  const ensureCtx = () => {
    if (!playRef.current) playRef.current = new AudioContext({ sampleRate: 24000 });
    if (playRef.current.state === "suspended") void playRef.current.resume();
    return playRef.current;
  };
  // Host is (still) talking → close the mic so it can't hear the speakers; drop anything it
  // half-heard (abort, not stop — we don't want his voice finalized as our reply). Do NOT
  // cancel a pending arm timer: it polls until ALL host audio drains (even across multiple
  // turns) and reopens the mic then. Cancelling it here was leaving the mic shut forever
  // whenever the host's reply came as more than one audio segment.
  const muteMic = () => {
    if (listeningRef.current) {
      listeningRef.current = false;
      try { recogRef.current?.abort(); } catch { /* */ }
      setListening(false);
    }
  };
  const playPCM = (buf: ArrayBuffer) => {
    muteMic();   // host is (still) talking — never let the mic pick up the speakers
    const ctx = ensureCtx();
    const i16 = new Int16Array(buf), f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const ab = ctx.createBuffer(1, f32.length, 24000); ab.copyToChannel(f32, 0);
    const s = ctx.createBufferSource(); s.buffer = ab; s.connect(ctx.destination);
    const t = Math.max(ctx.currentTime + 0.02, nextRef.current); s.start(t); nextRef.current = t + ab.duration;
    sourcesRef.current.add(s); s.onended = () => sourcesRef.current.delete(s);
    // First audio of a pass → anchor the caption/action clock to its TRUE start time `t`
    // (accounts for TTS first-byte latency), so timed reveals/captions line up with the voice.
    if (awaitingAnchorRef.current) { captionAnchorRef.current = t; awaitingAnchorRef.current = false; }
  };
  const playSfx = async (name: string, duration = 2) => {
    const ctx = ensureCtx();
    const start = Math.max(ctx.currentTime + 0.02, nextRef.current);
    nextRef.current = start + Math.max(0.25, duration - 0.45);
    try {
      const dec = await ctx.decodeAudioData(await (await fetch(`/sfx-audio/${name}.mp3`)).arrayBuffer());
      const s = ctx.createBufferSource(); const g = ctx.createGain(); g.gain.value = 0.45;
      s.buffer = dec; s.connect(g); g.connect(ctx.destination); s.start(start);
      nextRef.current = Math.max(nextRef.current, start + Math.max(0.25, dec.duration - 0.45));
      sourcesRef.current.add(s); s.onended = () => sourcesRef.current.delete(s);
    } catch { /* clip missing */ }
  };

  // Cut everything queued/playing and reset the timeline. Used to drop a stale backlog the
  // instant the game moves on (e.g. scores land) so the host never plays 20 sentences too late.
  const flushAudio = useCallback(() => {
    sourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* */ } });
    sourcesRef.current.clear();
    captionTimersRef.current.forEach((id) => clearTimeout(id));
    captionTimersRef.current = [];
    setHostCaption("");
    const ctx = playRef.current;
    if (ctx) nextRef.current = ctx.currentTime;
  }, []);

  // ── low background-music bed (fills dead air, e.g. while scoring) ──
  const musicRef = useRef<{ src: AudioBufferSourceNode; gain: GainNode } | null>(null);
  const startMusic = useCallback(async (name: string, vol = 0.1) => {
    if (musicRef.current) return;   // already looping
    try {
      const ctx = ensureCtx();
      // /api/sfx/<name> generates + caches on first use (static /sfx-audio 404s until then).
      const dec = await ctx.decodeAudioData(await (await fetch(`/api/sfx/${name}`)).arrayBuffer());
      if (musicRef.current) return;
      const src = ctx.createBufferSource(); src.buffer = dec; src.loop = true;
      const gain = ctx.createGain(); gain.gain.value = vol;
      src.connect(gain); gain.connect(ctx.destination); src.start();
      musicRef.current = { src, gain };
    } catch { /* no music bed available — host speech still fills the gap */ }
  }, []);
  const stopMusic = useCallback(() => {
    const m = musicRef.current; musicRef.current = null;
    if (!m) return;
    try {
      const ctx = playRef.current;
      if (ctx) { m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.25); m.src.stop(ctx.currentTime + 0.7); }
      else m.src.stop();
    } catch { /* */ }
  }, []);

  // ms until the host's queued audio finishes playing (0 if silent). Lets callers wait
  // for him to stop talking before starting the music, so they never overlap.
  const remainingAudioMs = useCallback(() => {
    const ctx = playRef.current;
    if (!ctx) return 0;
    return Math.max(0, (nextRef.current - ctx.currentTime) * 1000);
  }, []);

  const tell = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "text", text }));
  }, []);

  // ── browser speech-to-text (your reply) ──
  const stopListening = useCallback(() => {
    expectReplyRef.current = false;
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    try { recogRef.current?.stop(); } catch { /* */ }
  }, []);
  const startListening = useCallback(() => {
    if (!SR || listeningRef.current) return;
    gotFinalRef.current = false;
    const recog = new SR();
    recog.lang = "en-US"; recog.interimResults = true; recog.continuous = false;
    recog.onstart = () => { listeningRef.current = true; setListening(true); };
    recog.onend = () => {
      listeningRef.current = false; setListening(false);
      // The recognizer ends on a no-speech timeout (or after we aborted it for host audio).
      // If the host is still waiting on an answer, reopen the mic so the reply is never
      // missed — this is the fix for "won't take in audio when asked to go".
      if (!gotFinalRef.current && expectReplyRef.current && autoListenRef.current) armRef.current();
    };
    recog.onerror = () => { listeningRef.current = false; setListening(false); };
    recog.onresult = (e: any) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      setYouCaption(interim || final);
      if (final) {
        gotFinalRef.current = true; expectReplyRef.current = false;   // got the answer — stop reopening
        tell(final);
        try { recog.stop(); } catch { /* */ }
        setTimeout(() => setYouCaption(""), 1500);
      }
    };
    recogRef.current = recog;
    try { recog.start(); } catch { /* */ }
  }, []);

  // Open the mic once the host's queued audio has fully drained — never while he's talking
  // (avoids feedback). It polls the audio timeline, so newly-arriving host audio just pushes
  // the open later instead of cancelling it. `expectReplyRef` keeps us re-opening until the
  // player actually answers.
  const armListenWhenQuiet = useCallback(() => {
    if (!autoListenRef.current) return;
    expectReplyRef.current = true;
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    const GRACE = 900;   // he must be silent this long before we trust he's actually finished
    const tick = () => {
      armTimerRef.current = null;
      if (!autoListenRef.current || !expectReplyRef.current) return;
      const left = remainingAudioMs();
      if (left > 120) {
        // still playing → poll again once it should be drained
        armTimerRef.current = setTimeout(tick, Math.min(left + 60, 400));
        return;
      }
      // Looks quiet — but he may just be between sentences/turns (e.g. "P1 done!" … "Player 2,
      // ready?"). Wait a grace beat and only open the mic if he's STILL quiet, so we never
      // catch the tail of his own voice and send it back as the player's reply (which cut him
      // off). If he resumed talking, keep waiting.
      armTimerRef.current = setTimeout(() => {
        armTimerRef.current = null;
        if (!autoListenRef.current || !expectReplyRef.current) return;
        if (remainingAudioMs() > 120) armTimerRef.current = setTimeout(tick, 200);
        else startListening();
      }, GRACE);
    };
    armTimerRef.current = setTimeout(tick, 80);
  }, [remainingAudioMs, startListening]);
  armRef.current = armListenWhenQuiet;

  const connect = useCallback((autoListen = true) => {
    // Unlock + resume the AudioContext *inside* the caller's user gesture (e.g. the
    // Create Room click). Browsers keep it suspended otherwise, so the host's greeting
    // would stay silent until the next click — which is why he "only started after the
    // game started". Creating it here, within the gesture, lets the greeting play now.
    ensureCtx();
    if (wsRef.current && wsRef.current.readyState <= 1) return;
    autoListenRef.current = autoListen;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const mode = opts.gamemode ? `?mode=${encodeURIComponent(opts.gamemode)}` : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws/host${mode}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: "mode", autostart: false, gamemode: opts.gamemode || "karaoke" })); };
    ws.onclose = () => { setConnected(false); setListening(false); };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { playPCM(ev.data); return; }
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      // helper: schedule a callback to fire when the host's voice reaches `offset_ms` into the
      // current pass (relative to the anchored true audio-start time).
      const atAudio = (offsetMs: number, fn: () => void) => {
        const ctx = ensureCtx();
        const delay = Math.max(0, (captionAnchorRef.current + offsetMs / 1000 - ctx.currentTime) * 1000);
        captionTimersRef.current.push(setTimeout(fn, delay));
      };

      if (m.type === "audio_anchor") {
        // Next playPCM captures the true audio-start time for this turn pass.
        awaitingAnchorRef.current = true;
        const ctx = ensureCtx();
        captionAnchorRef.current = Math.max(ctx.currentTime, nextRef.current);   // provisional until first chunk
      }
      else if (m.type === "sfx") {
        if (typeof m.at_ms === "number") atAudio(m.at_ms, () => void playSfx(m.name, m.duration));
        else void playSfx(m.name, m.duration);
      }
      else if (m.type === "game") {
        // Fire the game command (e.g. reveal_scores) WHEN the host's voice reaches it, so the
        // 3-2-1 reveal lands exactly as he says it instead of early/late.
        const cmd = m.command;
        if (typeof m.at_ms === "number") atAudio(m.at_ms, () => onCommandRef.current(cmd));
        else onCommandRef.current(cmd);
      }
      else if (m.type === "caption_cues") {
        // Phrase captions timed across the audio, so the words advance with the voice.
        for (const c of (m.cues || [])) atAudio(c.offset_ms || 0, () => setHostCaption(c.text));
      }
      else if (m.type === "turn_complete") {
        // Host finished a spoken turn → clear the caption only after his audio has fully
        // drained (so the last line stays up while he says it). Give the page a chance to
        // act first; if it doesn't claim the turn, open the mic once the audio has drained.
        setTimeout(() => setHostCaption(""), remainingAudioMs() + 1800);
        const handled = onTurnCompleteRef.current?.();
        if (handled) {
          // Suppressed (starting a turn / scoring filler) → stop expecting a reply and
          // cancel any pending arm so the mic doesn't pop open during the countdown or game.
          expectReplyRef.current = false;
          if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
        } else {
          armListenWhenQuiet();
        }
      }
    };
  }, [armListenWhenQuiet]);

  const disconnect = useCallback(() => { autoListenRef.current = false; stopListening(); stopMusic(); wsRef.current?.close(); wsRef.current = null; }, [stopListening, stopMusic]);
  const begin = useCallback(() => tell("The players are ready — start the game now! Hype them up and begin Player 1's turn."), [tell]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { connect, disconnect, tell, begin, connected, listening, hostCaption, youCaption, startListening, stopListening, remainingAudioMs, startMusic, stopMusic, flushAudio };
}
