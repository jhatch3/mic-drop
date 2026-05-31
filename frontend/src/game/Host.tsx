import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { motion } from "motion/react";
import { getSocket } from "./socket";
import { useVoiceHost } from "./useVoiceHost";
import type { RoomState } from "./types";
import IDL from "../idl/pitch_battle.json";
import { NeonHeading, NeonButton, CRTCard, ScoreBar } from "@/retro";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Static config (overridable by /api/oracle/pubkey on mount) ─────────────
const DEFAULT_PROGRAM_ID = "2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf";
const DEFAULT_TREASURY   = "2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm";
const FEE_BPS            = 100;  // 1%

const API_BASE = import.meta.env.VITE_API_BASE ?? "";  // "" → use Vite proxy

// ─── Demo P2 stake keypair ──────────────────────────────────────────────────
// MVP staking model (contracts/DIVERGENCES.md #3c): the laptop holds P2's
// keypair and stakes on its behalf so the match reaches `Staked` and the backend
// oracle can settle. The phone wallet stays identity/display only. We reuse the
// SAME storage key as the Solana test UI (App.tsx → "pb_p2_keypair") so this key
// is the one you already funded once on devnet — no fresh airdrop per game.
function persistedKeypair(storageKey: string): Keypair {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch { /* fall through and regenerate */ }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}
const demoP2 = persistedKeypair("pb_p2_keypair");

// ─── Types ───────────────────────────────────────────────────────────────────
type HostPhase = "lobby" | "waiting" | "gaming" | "scoring" | "finished";

interface OracleInfo {
  oracle_pubkey: string;
  program_id: string;
  treasury_pubkey: string;
  escrow_mode: "mock" | "devnet";
  rpc_url: string;
}

interface Song {
  song_id: string;
  title: string;
  artist: string;
  difficulty: number;
  duration_sec: number;
}

interface ScoreRow {
  song_id: string;
  player_id: string;
  score: number;
  frames_scored: number;
  frames_hit: number;
}

interface FinishResponse {
  scores: ScoreRow[];
  winner: "p1" | "p2" | "tie";
  commentary: string;
  mc_audio_url: string;
  payout_tx: string;
  leaderboard: Array<{ player: string; wins: number; losses: number; ties?: number }>;
}

// ─── PDAs ────────────────────────────────────────────────────────────────────
function matchPda(matchId: string, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("match"), Buffer.from(matchId)], programId,
  )[0];
}
function vaultPda(matchId: string, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(matchId)], programId,
  )[0];
}

// ─── Error detail extractor ──────────────────────────────────────────────────
// Anchor/web3 errors hide the useful bits behind .logs / .getLogs(). Surface
// everything so the on-screen log tells us EXACTLY which call failed and why.
function errDetail(e: any): string {
  const parts: string[] = [];
  if (e?.name) parts.push(`name=${e.name}`);
  if (e?.message) parts.push(`msg=${e.message}`);
  if (e?.code !== undefined) parts.push(`code=${e.code}`);
  // SendTransactionError carries simulation logs
  try {
    const logs = typeof e?.getLogs === "function" ? e.getLogs() : e?.logs;
    if (logs?.length) parts.push(`logs=${JSON.stringify(logs).slice(0, 800)}`);
  } catch { /* ignore */ }
  // Detect the devnet faucet rate-limit specifically
  if (/airdrop|faucet/i.test(e?.message ?? "")) {
    parts.push("⚠️ FAUCET-RATE-LIMIT (not an RPC issue — faucet.solana.com is shared/per-IP)");
  }
  return parts.join(" | ") || String(e);
}

// Is this balance enough to cover the stake + a tx fee?
function lamportsNeededFor(stakeLamports: number): number {
  return stakeLamports + 2_000_000; // stake + ~0.002 SOL fee/rent headroom
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function Host() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const socket = getSocket();

  // Bootstrap from backend
  const [oracle, setOracle] = useState<OracleInfo | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [selectedSongId, setSelectedSongId] = useState<string>("");

  const [stakeSOL, setStakeSOL] = useState("0.01");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [phase, setPhase] = useState<HostPhase>("lobby");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [currentTurn, setCurrentTurn] = useState<{ player: string; wallet: string } | null>(null);
  const [finish, setFinish] = useState<FinishResponse | null>(null);
  const [p2Bal, setP2Bal] = useState<number | null>(null);

  // Audio capture (laptop owns the mic — phones never record)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const takesRef = useRef<{ p1?: Blob; p2?: Blob }>({});
  const matchIdRef = useRef<string | null>(null);

  const addLog = (msg: string) =>
    setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  // ── Bootstrap: oracle pubkey + song catalog ─────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/oracle/pubkey`);
        if (r.ok) setOracle(await r.json());
        else addLog(`oracle: backend returned ${r.status} (running mock?)`);
      } catch (e: any) {
        addLog(`oracle: ${e.message} (backend down?)`);
      }
      try {
        const r = await fetch(`${API_BASE}/api/songs`);
        if (r.ok) {
          const list: Song[] = await r.json();
          setSongs(list);
          if (list.length && !selectedSongId) setSelectedSongId(list[0].song_id);
        }
      } catch (e: any) {
        addLog(`songs: ${e.message}`);
      }
      try {
        const bal = await connection.getBalance(demoP2.publicKey);
        setP2Bal(bal / LAMPORTS_PER_SOL);
        addLog(`Demo P2 key ${demoP2.publicKey.toBase58().slice(0, 8)}… — ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
      } catch { /* devnet unreachable — checked again at stake time */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Socket events ───────────────────────────────────────────────────────
  useEffect(() => {
    socket.on("room:created", (r: RoomState) => {
      setRoom(r);
      setPhase("waiting");
      addLog(`Room ${r.code} created. Waiting for P2…`);
    });
    socket.on("room:updated", (r: RoomState) => {
      setRoom(r);
      if (r.players.length === 2 && phase === "waiting") {
        addLog(`${r.players[1].wallet.slice(0, 6)}… joined as P2`);
      }
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom(r);
      setPhase("gaming");
      addLog("Game started!");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      setCurrentTurn(t);
      addLog(`${t.player}'s turn — recording`);
      void startRecording();
    });
    socket.on("game:over", () => {
      // Server's tally is bogus (we pushed 0s to drive state); ignore it.
      // The real result arrives from POST /api/match/finish below.
    });
    socket.on("error", ({ msg }: { msg: string }) => addLog(`Error: ${msg}`));

    return () => { socket.removeAllListeners(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, phase]);

  // ── Anchor program (laptop signs create_match + stake_p1 only) ──────────
  const getProgram = useCallback(() => {
    if (!wallet.wallet?.adapter || !wallet.publicKey) throw new Error("Wallet not connected");
    const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
    return new Program(IDL as any, provider);
  }, [wallet, connection]);

  // ── Lobby → create socket room ──────────────────────────────────────────
  const createRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    if (!selectedSongId) { addLog("Pick a song first"); return; }
    setBusy(true);
    const stake = Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL);
    addLog(`Creating room (song: ${selectedSongId})…`);
    socket.emit("room:create", { wallet: wallet.publicKey.toBase58(), stake });
    setBusy(false);
  }, [wallet.publicKey, stakeSOL, socket, selectedSongId]);

  // Fund the demo P2 key so it can cover its stake. Faucet-FIRST (free), then
  // fall back to a direct transfer from the connected P1 wallet (faucet-INDEPENDENT
  // — P1 is a real funded Phantom wallet, so this always works even when the
  // devnet faucet is dry/rate-limited). Throws only if BOTH paths fail.
  const fundDemoP2 = useCallback(async (program: Program) => {
    const need = lamportsNeededFor(room!.stake);
    let bal = await connection.getBalance(demoP2.publicKey);
    addLog(`[fund] P2 balance=${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL, need=${(need / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal >= need) { addLog("[fund] P2 already funded ✓ (no faucet/transfer needed)"); return; }

    // 1) Try the faucet (best-effort, short).
    addLog("[fund] P2 low — trying devnet airdrop (faucet)…");
    try {
      const sig = await connection.requestAirdrop(demoP2.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      bal = await connection.getBalance(demoP2.publicKey);
      addLog(`[fund] airdrop landed ✓ P2 balance=${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e: any) {
      addLog(`[fund] airdrop failed → ${errDetail(e)}`);
    }
    if (bal >= need) return;

    // 2) Fallback: transfer from the connected P1 wallet. This needs P1 to sign
    //    one extra Phantom popup, but it does NOT touch the faucet.
    const topUp = need - bal;
    const p1Bal = await connection.getBalance(wallet.publicKey!);
    addLog(`[fund] faucet unavailable — transferring ${(topUp / LAMPORTS_PER_SOL).toFixed(4)} SOL from P1 (P1 has ${(p1Bal / LAMPORTS_PER_SOL).toFixed(4)} SOL). Approve in Phantom…`);
    if (p1Bal < topUp + 5_000) {
      throw new Error(`P1 wallet too low to fund P2 (has ${(p1Bal / LAMPORTS_PER_SOL).toFixed(4)} SOL, needs ${(topUp / LAMPORTS_PER_SOL).toFixed(4)} + fee). Fund your Phantom wallet on devnet.`);
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey!,
        toPubkey: demoP2.publicKey,
        lamports: topUp,
      }),
    );
    // AnchorProvider.sendAndConfirm signs with the connected wallet (P1).
    const sig = await (program.provider as AnchorProvider).sendAndConfirm(tx);
    bal = await connection.getBalance(demoP2.publicKey);
    addLog(`[fund] P1→P2 transfer confirmed ✓ (${sig.slice(0, 12)}…) P2 balance=${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    if (bal < need) throw new Error(`P2 still underfunded after transfer (${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL).`);
  }, [room, connection, wallet.publicKey]);

  // ── Start game: create on-chain match + stake P1, then kick off turns ───
  const startGame = useCallback(async () => {
    if (!room || !wallet.publicKey) return;
    if (!oracle) { addLog("Oracle pubkey not loaded yet — wait for backend"); return; }
    if (!selectedSongId) { addLog("Pick a song first"); return; }
    setBusy(true);

    // Step-by-step instrumentation: every on-chain call is wrapped so the log
    // pinpoints EXACTLY which step throws and with what detail.
    let step = "init";
    try {
      addLog(`[start] RPC endpoint = ${connection.rpcEndpoint}`);
      addLog(`[start] escrow_mode = ${oracle.escrow_mode}, program = ${oracle.program_id.slice(0, 8)}…`);

      const programId = new PublicKey(oracle.program_id);
      const treasury  = new PublicKey(oracle.treasury_pubkey);
      const oraclePk  = new PublicKey(oracle.oracle_pubkey);
      const program = getProgram();
      const matchId = room.code;
      matchIdRef.current = matchId;
      const mPda = matchPda(matchId, programId);
      const vPda = vaultPda(matchId, programId);
      addLog(`[start] matchId=${matchId} matchPda=${mPda.toBase58().slice(0, 8)}… vaultPda=${vPda.toBase58().slice(0, 8)}…`);

      // Sanity: P1 (connected wallet) must have SOL to pay rent + its own stake.
      const p1Bal = await connection.getBalance(wallet.publicKey);
      addLog(`[start] P1 (${wallet.publicKey.toBase58().slice(0, 8)}…) balance=${(p1Bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      if (p1Bal < lamportsNeededFor(room.stake)) {
        addLog(`⚠️ P1 may be too low to create+stake (need ≳${(lamportsNeededFor(room.stake) / LAMPORTS_PER_SOL).toFixed(4)} SOL). Fund your Phantom wallet on devnet.`);
      }

      // Does the match already exist on-chain from a prior attempt?
      step = "fetch-existing-match";
      let matchExists = false;
      try {
        await (program.account as any).match.fetch(mPda);
        matchExists = true;
        addLog("[start] match PDA already exists on-chain — skipping createMatch (resuming).");
      } catch {
        addLog("[start] match PDA not found — will create it.");
      }

      // 1) Create the escrow match account (P1/Phantom pays rent + signs).
      if (!matchExists) {
        step = "createMatch";
        addLog("[createMatch] sending… (approve in Phantom)");
        const t0 = performance.now();
        const sig = await program.methods
          .createMatch(matchId, new BN(room.stake), demoP2.publicKey, oraclePk, treasury, FEE_BPS)
          .accounts({
            playerOne: wallet.publicKey,
            matchAccount: mPda,
            vault: vPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        addLog(`[createMatch] ✓ ${sig.slice(0, 12)}… (${Math.round(performance.now() - t0)}ms)`);
      }

      // 2) Stake P1 (Phantom signs).
      step = "stakeP1";
      addLog("[stakeP1] sending… (approve in Phantom)");
      {
        const t0 = performance.now();
        const sig = await program.methods
          .stake(matchId)
          .accounts({
            signer: wallet.publicKey,
            matchAccount: mPda,
            vault: vPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        addLog(`[stakeP1] ✓ ${sig.slice(0, 12)}… (${Math.round(performance.now() - t0)}ms)`);
      }

      // 3) Fund the demo P2 key (faucet → P1-transfer fallback).
      step = "fundDemoP2";
      await fundDemoP2(program);

      // 4) Stake P2 (laptop-held demo key signs locally — no Phantom popup).
      step = "stakeP2";
      addLog("[stakeP2] sending… (demo key signs locally)");
      {
        const t0 = performance.now();
        const sig = await program.methods
          .stake(matchId)
          .accounts({
            signer: demoP2.publicKey,
            matchAccount: mPda,
            vault: vPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([demoP2])
          .rpc();
        addLog(`[stakeP2] ✓ ${sig.slice(0, 12)}… (${Math.round(performance.now() - t0)}ms)`);
      }

      setP2Bal((await connection.getBalance(demoP2.publicKey)) / LAMPORTS_PER_SOL);
      addLog("✅ Match fully staked — backend oracle can settle. Starting turns…");

      socket.emit("match:set_id", { code: room.code, matchId });
      // Solo (no phone joined): tell the server to inject the demo key as P2 so
      // the turn flow runs; you sing both takes into this laptop.
      const soloP2Wallet = room.players.length < 2 ? demoP2.publicKey.toBase58() : undefined;
      socket.emit("game:start", { code: room.code, soloP2Wallet });
    } catch (e: any) {
      // Mirror to devtools console with the full object for stack/inspection.
      // eslint-disable-next-line no-console
      console.error(`[startGame] failed at step "${step}":`, e);
      addLog(`❌ FAILED at step "${step}" → ${errDetail(e)}`);
    }
    setBusy(false);
  }, [room, wallet.publicKey, oracle, selectedSongId, getProgram, socket, connection, fundDemoP2]);

  // ── Mic capture ─────────────────────────────────────────────────────────
  async function startRecording() {
    if (recorderRef.current && recorderRef.current.state === "recording") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: pickMime() });
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.start(250);
      recorderRef.current = rec;
    } catch (e: any) {
      addLog(`mic error: ${e.message}`);
    }
  }

  function stopRecording(): Promise<Blob | null> {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        rec.stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        chunksRef.current = [];
        resolve(blob);
      };
      rec.stop();
    });
  }

  // ── End turn: stop recording, advance server state, finish on P2 ───────
  const endTurn = useCallback(async () => {
    if (!room || !currentTurn) return;
    const playerKey = currentTurn.player === "P1" ? "p1" : "p2";
    addLog(`Stopping ${currentTurn.player} recording…`);
    const blob = await stopRecording();
    if (blob) takesRef.current[playerKey] = blob;
    setCurrentTurn(null);

    // Advance server state — we push a placeholder score and override at the end.
    socket.emit("score:submit", {
      code: room.code,
      wallet: currentTurn.wallet,
      score: 0,
    });

    // After P2 finishes, we have both takes — call /api/match/finish.
    if (playerKey === "p2" && takesRef.current.p1 && takesRef.current.p2) {
      void finishMatch();
    }
  }, [room, currentTurn, socket]);

  const finishMatch = useCallback(async () => {
    if (!room || !matchIdRef.current) return;
    setPhase("scoring");
    addLog("Scoring both takes on the backend…");

    const fd = new FormData();
    fd.append("match_id", matchIdRef.current);
    fd.append("song_id", selectedSongId);
    fd.append("p1_pubkey", room.players[0].wallet);
    // The demo key is the on-chain player_two + payout destination, so it must be
    // what the oracle settles to and what Snowflake records for P2.
    fd.append("p2_pubkey", demoP2.publicKey.toBase58());
    fd.append("stake_lamports", String(room.stake));
    fd.append("fee_bps", String(FEE_BPS));
    fd.append("take_p1", takesRef.current.p1!, "p1.webm");
    fd.append("take_p2", takesRef.current.p2!, "p2.webm");

    try {
      const r = await fetch(`${API_BASE}/api/match/finish`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const result: FinishResponse = await r.json();
      setFinish(result);
      setPhase("finished");
      addLog(`Result: ${result.winner.toUpperCase()} | payout_tx=${result.payout_tx}`);

      // Broadcast to phones so the Player UI shows the real winner.
      socket.emit("match:finished", { code: room.code, ...result });
    } catch (e: any) {
      addLog("finish error: " + e.message);
      setPhase("finished");
    }
  }, [room, selectedSongId, socket]);

  // ── Live AI host: its tool calls drive THIS game; we narrate events back to it ──
  const voice = useVoiceHost({
    onCommand: (cmd) => {
      if (cmd === "start_game") { if (phase === "waiting" && !busy) void startGame(); }
      else if (cmd === "start_p2_turn") { void endTurn(); }   // end P1 → server advances to P2
      else if (cmd === "end_game") { void endTurn(); }        // end P2 → finishMatch
      // start_p1_turn: server auto-starts P1 recording on game:start — narration only
    },
    onCaption: (role, text) => addLog(`${role === "host" ? "🎙" : "🧑"} ${text}`),
  });

  // Hype each turn through the live host.
  useEffect(() => {
    if (voice.connected && currentTurn)
      voice.tell(`${currentTurn.player} is up to sing now — hype them in ONE short line.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTurn, voice.connected]);

  // Announce + roast the real result through the live host.
  useEffect(() => {
    if (voice.connected && finish) {
      const s1 = finish.scores?.[0]?.score ?? 0, s2 = finish.scores?.[1]?.score ?? 0;
      voice.tell(`The scores are in: Player 1 ${s1}, Player 2 ${s2}. The winner is ${finish.winner}. `
        + `Announce the winner with big energy, play the applause sound, then roast the loser in one line.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish, voice.connected]);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;
  const winnerWallet =
    finish?.winner === "p1" ? room?.players[0].wallet
    : finish?.winner === "p2" ? room?.players[1].wallet
    : null;
  const scoreFor = (idx: 0 | 1) => finish?.scores[idx]?.score ?? null;

  const labelCls = "font-display text-[10px] uppercase tracking-widest text-muted-foreground";
  const monoCls = "font-mono text-xs break-all text-foreground/80";

  return (
    <div className="relative z-10 min-h-screen px-4 py-8 text-foreground">
      <div className="mx-auto w-full max-w-xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between gap-4">
          <NeonHeading className="text-lg sm:text-xl">PITCH&nbsp;BATTLE</NeonHeading>
          <WalletMultiButton />
        </div>

        {/* Lobby */}
        {phase === "lobby" && (
          <CRTCard title="Create a Game" className="space-y-4">
            <div className="space-y-1.5">
              <label className={labelCls}>Song</label>
              <Select
                value={selectedSongId}
                onValueChange={setSelectedSongId}
                disabled={songs.length === 0}
              >
                <SelectTrigger className="w-full font-body text-base">
                  <SelectValue placeholder={songs.length ? "Pick a song" : "Loading…"} />
                </SelectTrigger>
                <SelectContent>
                  {songs.map((s) => (
                    <SelectItem key={s.song_id} value={s.song_id}>
                      {s.title} — {s.artist} (diff {s.difficulty})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Wager (SOL)</label>
              <Input
                type="number"
                step="0.01"
                min="0.001"
                value={stakeSOL}
                onChange={(e) => setStakeSOL(e.target.value)}
                className="font-body text-base"
              />
            </div>

            {oracle && (
              <div className={labelCls}>
                Oracle: <span className={monoCls}>{oracle.oracle_pubkey.slice(0, 16)}…</span>{" "}
                <span className="text-cyan">({oracle.escrow_mode})</span>
              </div>
            )}

            {oracle?.escrow_mode === "devnet" && (
              <div className={cn(labelCls, p2Bal !== null && p2Bal < 0.015 && "text-destructive")}>
                Demo P2 key: <span className={monoCls}>{demoP2.publicKey.toBase58().slice(0, 16)}…</span>
                {p2Bal !== null && ` (${p2Bal.toFixed(3)} SOL)`}
              </div>
            )}

            <NeonButton
              onClick={createRoom}
              disabled={busy || !wallet.publicKey || !selectedSongId}
              size="lg"
              className="w-full"
            >
              {busy ? "…" : wallet.publicKey ? "▶ Create Room" : "Connect Wallet First"}
            </NeonButton>
          </CRTCard>
        )}

        {/* Waiting */}
        {phase === "waiting" && room && (
          <CRTCard title="Share the Code" glow="cyan" className="text-center">
            <div className="font-display text-cyan text-glow my-4 text-4xl tracking-[0.3em]">
              {room.code}
            </div>
            {joinUrl && (
              <div className="mx-auto my-4 w-fit rounded-xl bg-white p-4">
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div className="mb-4 break-all text-xs text-muted-foreground">{joinUrl}</div>
            <div className={cn(labelCls, "mb-2 text-left")}>
              Players joined: {room.players.length} / 2
            </div>
            <div className="space-y-1 text-left">
              {room.players.map((p) => (
                <div key={p.wallet} className="border-b border-border/50 py-1.5 font-mono text-sm">
                  <span className="text-lime text-glow-sm">✓</span> {p.name} — {p.wallet.slice(0, 10)}…
                </div>
              ))}
            </div>
            {room.players.length >= 1 && (
              <NeonButton onClick={startGame} disabled={busy} variant="lime" size="lg" className="mt-4 w-full">
                {busy
                  ? "…"
                  : room.players.length >= 2
                    ? "🔒 Start Game & Lock Wagers"
                    : "🎤 Start Solo (you sing both turns)"}
              </NeonButton>
            )}
            {room.players.length >= 1 && (
              <NeonButton onClick={voice.connect} disabled={voice.connected} variant="cyan" className="mt-2 w-full">
                {voice.connected ? "🎙 AI Host is running the show" : "🎙 Let the AI Host start it"}
              </NeonButton>
            )}
          </CRTCard>
        )}

        {/* Gaming */}
        {phase === "gaming" && room && (
          <CRTCard title={currentTurn ? "Now Singing" : "Get Ready"} glow="magenta" className="space-y-4">
            {currentTurn ? (
              <>
                <div className="flex items-center gap-3">
                  <motion.span
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ repeat: Infinity, duration: 1.1 }}
                    className="inline-block h-3 w-3 rounded-full bg-destructive shadow-[0_0_10px_#ff3864]"
                  />
                  <span className="font-display text-magenta text-glow text-base">
                    {currentTurn.player}
                  </span>
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {currentTurn.wallet.slice(0, 10)}… — recording from this laptop's mic
                </div>
                <NeonButton onClick={endTurn} variant="lime" size="lg" className="w-full">
                  End {currentTurn.player} Turn
                </NeonButton>
              </>
            ) : (
              <div className="font-mono text-sm text-muted-foreground">Waiting for the turn to start…</div>
            )}
            <div className={labelCls}>Song: {selectedSongId}</div>
          </CRTCard>
        )}

        {/* Scoring */}
        {phase === "scoring" && (
          <CRTCard title="Scoring" glow="purple">
            <div className="flex items-center gap-3">
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                className="inline-block h-4 w-4 rounded-full border-2 border-purple border-t-transparent"
              />
              <span className="font-display text-purple text-glow text-sm">Analyzing both takes…</span>
            </div>
            <div className="mt-3 font-mono text-xs text-muted-foreground">
              Backend is running pyin on both takes. Hold tight.
            </div>
          </CRTCard>
        )}

        {/* Finished */}
        {phase === "finished" && room && finish && (
          <CRTCard title="Game Over" className="space-y-5">
            <div className="flex items-center justify-center gap-4">
              <NeonHeading as="h2" color="lime" className="text-base">
                {finish.winner === "tie" ? "TIE!" : `${finish.winner.toUpperCase()} WINS`}
              </NeonHeading>
            </div>

            <div className="space-y-4">
              {room.players.map((p, i) => {
                const s = scoreFor(i as 0 | 1);
                const isWinner = p.wallet === winnerWallet;
                return (
                  <div key={p.wallet} className="space-y-1.5">
                    <div className="flex items-center justify-between font-mono text-sm">
                      <span className={isWinner ? "text-lime text-glow-sm" : "text-foreground"}>
                        {isWinner ? "🏆 " : ""}{p.name}
                      </span>
                      <span className="font-display text-xs">{s ?? "—"}/100</span>
                    </div>
                    <ScoreBar value={s ?? 0} color={isWinner ? "lime" : "magenta"} />
                  </div>
                );
              })}
            </div>

            <div className="border-l-2 border-magenta pl-3 font-body text-base italic text-foreground/90">
              “{finish.commentary}”
            </div>

            {finish.mc_audio_url && (
              <audio
                controls
                autoPlay={!voice.connected}
                src={`${API_BASE}${finish.mc_audio_url}`}
                className="w-full"
              />
            )}

            <div className="space-y-1">
              <div className={labelCls}>Payout</div>
              <div className={monoCls}>{finish.payout_tx}</div>
              {finish.payout_tx.length > 50 && oracle?.escrow_mode === "devnet" && (
                <a
                  href={`https://explorer.solana.com/tx/${finish.payout_tx}?cluster=devnet`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-cyan underline-offset-4 hover:underline"
                >
                  view on explorer ↗
                </a>
              )}
            </div>

            {finish.leaderboard?.length > 0 && (
              <div className="space-y-1">
                <div className={labelCls}>Leaderboard</div>
                {finish.leaderboard.slice(0, 5).map((row, i) => (
                  <div key={i} className="border-b border-border/50 py-1 font-mono text-sm">
                    {row.player}: <span className="text-lime">{row.wins}W</span> / <span className="text-destructive">{row.losses}L</span>
                  </div>
                ))}
              </div>
            )}
          </CRTCard>
        )}

        {/* Log */}
        <CRTCard title="Log" glow="purple" animate={false} className="mt-3 bg-card/60">
          <div className="max-h-40 space-y-0.5 overflow-y-auto">
            {log.length === 0 && <div className="text-xs text-muted-foreground/60">Events will appear here</div>}
            {log.map((l, i) => (
              <div key={i} className="font-mono text-xs text-muted-foreground">{l}</div>
            ))}
          </div>
        </CRTCard>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
