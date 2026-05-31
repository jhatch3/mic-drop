import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { useGameRoom } from "../services/useGameRoom";
import { useEscrow } from "../services/useEscrow";
import { useVoiceHost } from "./useVoiceHost";
import Karaoke, { type KaraokeResult } from "./Karaoke";
import { NeonHeading, NeonButton, CRTCard } from "@/retro";
import { Input } from "@/components/ui/input";

// Closed-caption bar pinned to the bottom while the AI host (or you) is talking.
function Captions({ host, you }: { host: string; you: string }) {
  if (!host && !you) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-1 p-4">
      {host && <div className="max-w-2xl rounded-lg bg-black/80 px-4 py-2 text-center font-body text-lg text-pink"><span className="text-magenta">🎙</span> {host}</div>}
      {you && <div className="max-w-2xl rounded-lg bg-black/70 px-4 py-1.5 text-center font-body text-base text-lime">🧑 {you}</div>}
    </div>
  );
}

const labelCls = "font-display text-[10px] uppercase tracking-widest text-muted-foreground";
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface ScoreRow { player_id: string; score: number; pitch_score?: number; lyrics_score?: number; transcript?: string; }
interface FinishResponse {
  scores: ScoreRow[]; winner: "p1" | "p2" | "tie"; commentary: string;
  mc_audio_url: string; payout_tx: string; leaderboard: Array<{ player: string; wins: number; losses: number }>;
}

export default function KaraokeHost() {
  const wallet = useWallet();
  const [stakeSOL, setStakeSOL] = useState(
    () => new URLSearchParams(window.location.search).get("stake") ?? "0.001"
  );
  const { room, phase, currentTurn, log, addLog, createRoom, beginGame, submitScore } = useGameRoom();
  const { busy, createAndStake } = useEscrow(addLog);

  // Recorded takes → scored together on the backend (80% lyrics + 20% pitch).
  const takesRef = useRef<{ p1?: Blob; p2?: Blob }>({});
  const [finish, setFinish] = useState<FinishResponse | null>(null);
  const [scoring, setScoring] = useState(false);

  const handleCreateRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    createRoom(wallet.publicKey.toBase58(), Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL), "karaoke");
  }, [wallet.publicKey, stakeSOL, createRoom]);

  // The host starts the match (on "ready"). Staking is best-effort so the game
  // always begins — never blocks the autonomous flow on a wallet.
  const handleStartGame = useCallback(async () => {
    if (!room || phase !== "waiting") return;
    if (room.players.length >= 2) {
      try { await createAndStake(room.code, room.players[1].wallet, room.stake); }
      catch (e: any) { addLog("stake skipped: " + e.message); }
    }
    beginGame(room.code);
  }, [room, phase, createAndStake, beginGame, addLog]);

  // ── AI game-show host: greets, asks "ready?", you answer by voice, he starts the game ──
  const startRef = useRef(handleStartGame);
  startRef.current = handleStartGame;
  const voice = useVoiceHost({
    onCommand: (cmd) => { if (cmd === "start_game") void startRef.current(); },
  });
  // Bring the host in the moment the room exists (he introduces himself + auto-listens).
  useEffect(() => {
    if (phase === "waiting") voice.connect(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // After both takes are recorded, score them on the backend (80% lyrics + 20% pitch)
  // and let the host announce the real result.
  const finishMatch = useCallback(async () => {
    const { p1, p2 } = takesRef.current;
    if (!room || !p1 || !p2) return;
    setScoring(true);
    addLog("Scoring both takes (lyrics + pitch)…");
    // Keep the room entertained while the backend scores (~15-20s).
    voice.tell("Both singers are done! While the judges tally the scores, keep the crowd "
      + "entertained: share a fun fact about the song or artist, and explain how scoring "
      + "works — 80% on singing the right lyrics in time, 20% on pitch. Stall for time, "
      + "build suspense, but do NOT announce a winner yet.");
    const fd = new FormData();
    fd.append("match_id", room.matchId || room.code);
    fd.append("song_id", "firework");
    fd.append("p1_pubkey", room.players[0]?.wallet || "p1");
    fd.append("p2_pubkey", room.players[1]?.wallet || "p2");
    fd.append("stake_lamports", String(room.stake ?? 0));
    fd.append("take_p1", p1, "p1.webm");
    fd.append("take_p2", p2, "p2.webm");
    try {
      const r = await fetch(`${API_BASE}/api/match/finish`, { method: "POST", body: fd });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const res: FinishResponse = await r.json();
      setFinish(res);
      const s1 = res.scores[0]?.score ?? 0, s2 = res.scores[1]?.score ?? 0;
      addLog(`Result: ${res.winner.toUpperCase()} — P1 ${s1} / P2 ${s2}`);
      voice.tell(`The scores are in! Player 1 scored ${s1}, Player 2 scored ${s2}. The winner is ${res.winner}. Announce the winner with big energy, play the applause sound, then roast the loser in one line.`);
    } catch (e: any) {
      addLog("scoring failed: " + e.message);
    }
    setScoring(false);
  }, [room, addLog, voice]);

  // Each turn records a take; advance the socket turn state, and once both takes are in,
  // score on the backend.
  const handleTurnFinish = useCallback((result: KaraokeResult, take?: Blob) => {
    if (!currentTurn) return;
    const key = currentTurn.player === "P1" ? "p1" : "p2";
    if (take) takesRef.current[key] = take;
    addLog(`${currentTurn.player} done`);
    submitScore(currentTurn.wallet, result.score);   // advances p1→p2→finished
    if (takesRef.current.p1 && takesRef.current.p2) void finishMatch();
  }, [currentTurn, addLog, submitScore, finishMatch]);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;

  // Gaming turn: hand the whole screen to the live karaoke station (music auto-starts).
  if (phase === "gaming" && room && currentTurn) {
    return (
      <>
        <Karaoke
          key={currentTurn.wallet}
          playerLabel={`${currentTurn.player} — sing into this laptop!`}
          autoPlay
          onFinish={handleTurnFinish}
        />
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </>
    );
  }

  return (
    <div className="relative z-10 min-h-screen px-4 py-8 text-foreground">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <NeonHeading className="text-lg sm:text-xl">KARAOKE&nbsp;BATTLE</NeonHeading>
          <WalletMultiButton />
        </div>

        {phase === "lobby" && (
          <CRTCard title="Create a Game" className="space-y-4">
            <div className="space-y-1.5">
              <label className={labelCls}>Wager (SOL)</label>
              <Input type="number" step="0.001" min="0.001" value={stakeSOL}
                onChange={(e) => setStakeSOL(e.target.value)} className="font-body text-base" />
            </div>
            <NeonButton onClick={handleCreateRoom} disabled={busy || !wallet.publicKey} size="lg" className="w-full">
              {busy ? "…" : wallet.publicKey ? "▶ Create Room" : "Connect Wallet First"}
            </NeonButton>
          </CRTCard>
        )}

        {phase === "waiting" && room && (
          <CRTCard title="Share the Code" glow="cyan" className="text-center">
            <div className="font-display text-cyan text-glow my-4 text-4xl tracking-[0.3em]">{room.code}</div>
            {joinUrl && (
              <div className="mx-auto my-4 w-fit rounded-xl bg-white p-4"><QRCode value={joinUrl} size={180} /></div>
            )}
            <div className="mb-4 break-all text-xs text-muted-foreground">{joinUrl}</div>
            <div className={`${labelCls} mb-2 text-left`}>Players joined: {room.players.length} / 2</div>
            <div className="space-y-1 text-left">
              {room.players.map((p) => (
                <div key={p.wallet} className="border-b border-border/50 py-1.5 font-mono text-sm">
                  <span className="text-lime text-glow-sm">✓</span> {p.name} — {p.wallet.slice(0, 10)}…
                </div>
              ))}
            </div>
            <div className={`${labelCls} mt-4 normal-case tracking-normal`}>
              {voice.listening
                ? "🎙 Host is listening — say “yes, we’re ready!” and he'll start the game"
                : voice.connected
                  ? "🎙 The AI host is introducing the game…"
                  : "🎙 Bringing in the AI host…"}
            </div>
          </CRTCard>
        )}

        {phase === "gaming" && room && !currentTurn && (
          <CRTCard title="Get Ready" glow="magenta">
            <div className="space-y-1">
              {room.players.map((p) => (
                <div key={p.wallet} className="border-b border-border/50 py-1 font-mono text-sm">
                  {p.name}: {p.score !== null ? `${p.score}/100` : "—"}
                </div>
              ))}
            </div>
          </CRTCard>
        )}

        {phase === "finished" && room && (
          <CRTCard title="Game Over" className="space-y-4">
            {scoring && !finish && (
              <div className="font-display text-center text-sm text-purple text-glow">⏳ Scoring lyrics + pitch…</div>
            )}
            {finish ? (
              <>
                <NeonHeading as="h2" color="lime" className="text-center text-base">
                  {finish.winner === "tie" ? "IT'S A TIE" : `${finish.winner.toUpperCase()} WINS`}
                </NeonHeading>
                <div className="space-y-3">
                  {room.players.map((p, i) => {
                    const s = finish.scores[i];
                    const win = finish.winner === (i === 0 ? "p1" : "p2");
                    return (
                      <div key={p.wallet} className="space-y-1">
                        <div className="flex items-center justify-between font-mono text-sm">
                          <span className={win ? "text-lime text-glow-sm" : ""}>{win ? "🏆 " : ""}{p.name}</span>
                          <span className="font-display text-xs">{s?.score ?? "—"}/100</span>
                        </div>
                        <ScoreBar value={s?.score ?? 0} color={win ? "lime" : "magenta"} />
                        <div className="flex gap-4 font-mono text-[11px] text-muted-foreground">
                          <span>📝 lyrics {s?.lyrics_score ?? "—"} <span className="opacity-50">(×0.8)</span></span>
                          <span>🎵 pitch {s?.pitch_score ?? "—"} <span className="opacity-50">(×0.2)</span></span>
                        </div>
                        {s?.transcript && <div className="font-mono text-[11px] italic text-muted-foreground/70 break-words">heard: “{s.transcript}”</div>}
                      </div>
                    );
                  })}
                </div>
                {finish.commentary && (
                  <div className="border-l-2 border-magenta pl-3 font-body text-base italic text-foreground/90">“{finish.commentary}”</div>
                )}
                <div className="font-mono text-[11px] text-muted-foreground">payout: {finish.payout_tx}</div>
              </>
            ) : !scoring && (
              <div className="font-mono text-sm text-muted-foreground">Waiting for scores…</div>
            )}
          </CRTCard>
        )}

        <CRTCard title="Log" glow="purple" animate={false} className="mt-3 bg-card/60">
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {log.length === 0 && <div className="text-xs text-muted-foreground/60">Events will appear here</div>}
            {log.map((l, i) => <div key={i} className="font-mono text-xs text-muted-foreground">{l}</div>)}
          </div>
        </CRTCard>
      </div>
      <Captions host={voice.hostCaption} you={voice.youCaption} />
    </div>
  );
}
