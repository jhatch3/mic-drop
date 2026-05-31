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

export default function KaraokeHost() {
  const wallet = useWallet();
  const [stakeSOL, setStakeSOL] = useState(
    () => new URLSearchParams(window.location.search).get("stake") ?? "0.001"
  );
  const { room, phase, currentTurn, log, addLog, createRoom, beginGame, submitScore } = useGameRoom();
  const { busy, createAndStake, settle } = useEscrow(addLog);

  // The laptop is the karaoke station: it runs the real pitch+lyrics for whoever's
  // turn it is and submits the real score. (Phones never sing.)
  const handleTurnFinish = useCallback((result: KaraokeResult) => {
    if (!currentTurn) return;
    addLog(`${currentTurn.player}: ${result.score}/100`);
    submitScore(currentTurn.wallet, result.score);
  }, [currentTurn, addLog, submitScore]);

  const handleCreateRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    createRoom(wallet.publicKey.toBase58(), Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL), "karaoke");
  }, [wallet.publicKey, stakeSOL, createRoom]);

  const handleStartGame = useCallback(async () => {
    if (!room || room.players.length < 2) return;
    try {
      await createAndStake(room.code, room.players[1].wallet, room.stake);
      beginGame(room.code);
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
  }, [room, createAndStake, beginGame, addLog]);

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
            {room.players.length === 2 && (
              <NeonButton onClick={handleStartGame} disabled={busy} variant="lime" size="lg" className="mt-4 w-full">
                {busy ? "…" : "🔒 Start Game & Lock Wagers"}
              </NeonButton>
            )}
            <div className={`${labelCls} mt-3 normal-case tracking-normal`}>
              {voice.listening
                ? "🎙 Host is listening — say “yes, we’re ready!”"
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
            <NeonHeading as="h2" color="lime" className="text-center text-base">
              {room.winner ? "WE HAVE A WINNER" : "TIE"}
            </NeonHeading>
            <div className="space-y-1">
              {room.players.map((p) => (
                <div key={p.wallet} className={`flex items-center justify-between border-b border-border/50 py-1.5 font-mono text-sm ${p.wallet === room.winner ? "text-lime text-glow-sm" : ""}`}>
                  <span>{p.wallet === room.winner ? "🏆 " : ""}{p.name}</span>
                  <span className="font-display text-xs">{p.score ?? "—"}/100</span>
                </div>
              ))}
            </div>
            {room.winner && room.matchId && (
              <NeonButton onClick={() => settle(room.matchId!, room.winner!)} disabled={busy} variant="lime" size="lg" className="w-full">
                {busy ? "…" : "💸 Pay Winner on Solana"}
              </NeonButton>
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
