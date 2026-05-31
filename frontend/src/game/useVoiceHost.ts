import { useCallback, useRef, useState } from "react";

/**
 * Live AI game-show host, hooked into the real /host game.
 *
 *   /ws/host (Gemini Live)  ──▶  host voice (PCM24) + SFX  ──▶  speakers
 *                                tool calls ──▶ onCommand(start_game | start_p1_turn |
 *                                               start_p2_turn | end_game)
 *
 * The component maps onCommand to its real game actions (startGame / endTurn), and calls
 * `tell()` to feed game events back so the host narrates. Audio playback (host voice + SFX)
 * shares one timeline so they never overlap.
 */
type Command = "start_game" | "start_p1_turn" | "start_p2_turn" | "end_game";

export function useVoiceHost(opts: {
  onCommand: (cmd: Command) => void;
  onCaption?: (role: "host" | "user", text: string) => void;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const playRef = useRef<AudioContext | null>(null);
  const nextRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const ensureCtx = () => {
    if (!playRef.current) playRef.current = new AudioContext({ sampleRate: 24000 });
    if (playRef.current.state === "suspended") void playRef.current.resume();
    return playRef.current;
  };

  const playPCM = (buf: ArrayBuffer) => {
    const ctx = ensureCtx();
    const i16 = new Int16Array(buf);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const ab = ctx.createBuffer(1, f32.length, 24000);
    ab.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab; src.connect(ctx.destination);
    const t = Math.max(ctx.currentTime + 0.02, nextRef.current);
    src.start(t); nextRef.current = t + ab.duration;
  };

  const playSfx = async (name: string, duration = 2) => {
    const ctx = ensureCtx();
    const start = Math.max(ctx.currentTime + 0.02, nextRef.current);
    nextRef.current = start + Math.max(0.25, duration - 0.45);
    try {
      const ab = await (await fetch(`/sfx-audio/${name}.mp3`)).arrayBuffer();
      const dec = await ctx.decodeAudioData(ab);
      const src = ctx.createBufferSource();
      const g = ctx.createGain(); g.gain.value = 0.45;
      src.buffer = dec; src.connect(g); g.connect(ctx.destination);
      src.start(start);
      nextRef.current = Math.max(nextRef.current, start + Math.max(0.25, dec.duration - 0.45));
    } catch { /* clip missing */ }
  };

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/host`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { playPCM(ev.data); return; }
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "sfx") void playSfx(m.name, m.duration);
      else if (m.type === "game") optsRef.current.onCommand(m.command);
      else if (m.type === "caption") optsRef.current.onCaption?.(m.role, m.text);
    };
  }, []);

  const disconnect = useCallback(() => { wsRef.current?.close(); wsRef.current = null; }, []);

  /** Feed a game event to the host so it narrates (e.g. "Player 1 is up — hype them!"). */
  const tell = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "text", text }));
  }, []);

  return { connect, disconnect, tell, connected };
}
