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
type Command = "start_game" | "start_p1_turn" | "start_p2_turn" | "end_game";
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

export function useVoiceHost(opts: { onCommand: (cmd: Command) => void }) {
  const wsRef = useRef<WebSocket | null>(null);
  const playRef = useRef<AudioContext | null>(null);
  const nextRef = useRef(0);
  const recogRef = useRef<any>(null);
  const autoListenRef = useRef(true);
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [hostCaption, setHostCaption] = useState("");
  const [youCaption, setYouCaption] = useState("");
  const onCommandRef = useRef(opts.onCommand);
  onCommandRef.current = opts.onCommand;

  // ── host audio + SFX (shared timeline so they never overlap) ──
  const ensureCtx = () => {
    if (!playRef.current) playRef.current = new AudioContext({ sampleRate: 24000 });
    if (playRef.current.state === "suspended") void playRef.current.resume();
    return playRef.current;
  };
  const playPCM = (buf: ArrayBuffer) => {
    const ctx = ensureCtx();
    const i16 = new Int16Array(buf), f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const ab = ctx.createBuffer(1, f32.length, 24000); ab.copyToChannel(f32, 0);
    const s = ctx.createBufferSource(); s.buffer = ab; s.connect(ctx.destination);
    const t = Math.max(ctx.currentTime + 0.02, nextRef.current); s.start(t); nextRef.current = t + ab.duration;
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
    } catch { /* clip missing */ }
  };

  const tell = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "text", text }));
  }, []);

  // ── browser speech-to-text (your reply) ──
  const stopListening = useCallback(() => { try { recogRef.current?.stop(); } catch { /* */ } }, []);
  const startListening = useCallback(() => {
    if (!SR || listening) return;
    const recog = new SR();
    recog.lang = "en-US"; recog.interimResults = true; recog.continuous = false;
    recog.onstart = () => setListening(true);
    recog.onend = () => setListening(false);
    recog.onerror = () => setListening(false);
    recog.onresult = (e: any) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      setYouCaption(interim || final);
      if (final) { tell(final); try { recog.stop(); } catch { /* */ } setTimeout(() => setYouCaption(""), 1500); }
    };
    recogRef.current = recog;
    try { recog.start(); } catch { /* */ }
  }, [listening, tell]);

  const connect = useCallback((autoListen = true) => {
    if (wsRef.current && wsRef.current.readyState <= 1) return;
    autoListenRef.current = autoListen;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/host`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: "mode", autostart: false })); };
    ws.onclose = () => { setConnected(false); setListening(false); };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { playPCM(ev.data); return; }
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "sfx") void playSfx(m.name, m.duration);
      else if (m.type === "game") onCommandRef.current(m.command);
      else if (m.type === "caption" && m.role === "host") setHostCaption((c) => c + m.text);
      else if (m.type === "turn_complete") {
        // Host finished talking → clear the caption shortly, and auto-open the mic so
        // you can reply by voice (this is how "say yes to start" works).
        setTimeout(() => setHostCaption(""), 2500);
        if (autoListenRef.current) setTimeout(() => startListening(), 300);
      }
    };
  }, [startListening]);

  const disconnect = useCallback(() => { autoListenRef.current = false; stopListening(); wsRef.current?.close(); wsRef.current = null; }, [stopListening]);
  const begin = useCallback(() => tell("The players are ready — start the game now! Hype them up and begin Player 1's turn."), [tell]);

  useEffect(() => () => disconnect(), [disconnect]);

  return { connect, disconnect, tell, begin, connected, listening, hostCaption, youCaption, startListening, stopListening };
}
