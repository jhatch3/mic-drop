import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { getSocket } from "./socket";
import type { RoomState } from "./types";
import Karaoke, { type KaraokeResult } from "./Karaoke";
import IDL from "../idl/pitch_battle.json";

// ─── Static config ────────────────────────────────────────────────────────────
const DEFAULT_PROGRAM_ID  = "2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf";
const DEFAULT_TREASURY    = "2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm";
const FEE_BPS             = 100;  // 1%

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Persist a Keypair in localStorage so page reloads reuse the same key.
// The oracle keypair shares the same storage key as App.tsx so both UIs use
// the same oracle identity — fund it once and both flows work.
function persistedKeypair(storageKey: string): Keypair {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch { /* fall through */ }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}
// The oracle that signs settle() — must match the pubkey passed to createMatch.
const localOracle = persistedKeypair("pb_oracle_keypair");

// Fallback oracle info used when backend is unreachable.
// Uses localOracle so the frontend can settle without a backend.
const FALLBACK_ORACLE: OracleInfo = {
  oracle_pubkey:   localOracle.publicKey.toBase58(),
  program_id:      DEFAULT_PROGRAM_ID,
  treasury_pubkey: DEFAULT_TREASURY,
  escrow_mode:     "devnet",
  rpc_url:         "https://api.devnet.solana.com",
};

// Fallback song list used when backend is unreachable
const FALLBACK_SONGS: Song[] = [
  { song_id: "firework", title: "Firework", artist: "Katy Perry", difficulty: 3, duration_sec: 50 },
];


// ─── Types ───────────────────────────────────────────────────────────────────
type HostPhase = "lobby" | "waiting" | "gaming" | "waiting_p2" | "scoring" | "finished";

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
  const [p1Score, setP1Score] = useState<KaraokeResult | null>(null);
  const [p2Score, setP2Score] = useState<KaraokeResult | null>(null);
  const [finish, setFinish] = useState<FinishResponse | null>(null);
  const [waitingForP2Stake, setWaitingForP2Stake] = useState(false);

  // Audio capture (laptop owns the mic — phones never record)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const takesRef = useRef<{ p1?: Blob; p2?: Blob }>({});
  const matchIdRef = useRef<string | null>(null);
  // Holds the latest settle fn so the socket "game:over" handler (registered in an
  // effect with a stale closure) always calls the current version. Assigned below
  // once settleMatch is defined.
  const settleRef = useRef<(r: RoomState) => void>(() => {});

  const addLog = (msg: string) =>
    setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  // ── Bootstrap: oracle pubkey + song catalog ─────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/oracle/pubkey`);
        if (r.ok) {
          const data = await r.json();
          setOracle(data);
          addLog(`Oracle: ${data.oracle_pubkey.slice(0, 8)}… (backend)`);
        } else {
          setOracle(FALLBACK_ORACLE);
          addLog("Backend unreachable — using devnet defaults");
        }
      } catch {
        setOracle(FALLBACK_ORACLE);
        addLog("Backend offline — using devnet defaults");
      }
      try {
        const r = await fetch(`${API_BASE}/api/songs`);
        if (r.ok) {
          const list: Song[] = await r.json();
          setSongs(list);
          if (list.length && !selectedSongId) setSelectedSongId(list[0].song_id);
        } else {
          setSongs(FALLBACK_SONGS);
          setSelectedSongId(FALLBACK_SONGS[0].song_id);
        }
      } catch {
        setSongs(FALLBACK_SONGS);
        setSelectedSongId(FALLBACK_SONGS[0].song_id);
      }
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
      // The laptop only owns the mic for ITS player (P1). P2 sings on their own
      // device, so don't grab the laptop mic (or prompt for it) on P2's turn.
      if (wallet.publicKey && t.wallet === wallet.publicKey.toBase58()) {
        addLog(`${t.player}'s turn (you) — recording`);
        void startRecording();
      } else {
        addLog(`${t.player} is singing on their own device…`);
      }
    });
    socket.on("game:over", (r: RoomState) => {
      // Both players have submitted real scores (P1 from this laptop, P2 from
      // their own device). Settle on-chain from the room's authoritative scores.
      setRoom(r);
      addLog("Both takes in — settling on-chain…");
      settleRef.current(r);
    });
    socket.on("stakes:ready", (r: RoomState) => {
      setRoom(r);
      setWaitingForP2Stake(false);
      addLog("Both players staked ✓ — starting game");
      socket.emit("game:start", { code: r.code });
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
      // Always use the locally persisted oracle keypair so the frontend can
      // settle directly without a backend after the match.
      const oraclePk  = localOracle.publicKey;
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
        const p2Pubkey = new PublicKey(room.players[1].wallet);
        const sig = await program.methods
          .createMatch(matchId, new BN(room.stake), p2Pubkey, oraclePk, treasury, FEE_BPS)
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

      // 3) Set match ID so P2 can see it, then start the game immediately.
      socket.emit("match:set_id", { code: room.code, matchId });
      socket.emit("player:staked", { code: room.code, wallet: wallet.publicKey.toBase58() });
      socket.emit("game:start", { code: room.code });
      addLog("✅ P1 staked — game starting!");
    } catch (e: any) {
      // Mirror to devtools console with the full object for stack/inspection.
      // eslint-disable-next-line no-console
      console.error(`[startGame] failed at step "${step}":`, e);
      addLog(`❌ FAILED at step "${step}" → ${errDetail(e)}`);
    }
    setBusy(false);
  }, [room, wallet.publicKey, oracle, selectedSongId, getProgram, socket, connection]);

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
    fd.append("p2_pubkey", room.players[1]?.wallet ?? "");
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

  // Settle the on-chain escrow using the local oracle keypair and the two final
  // karaoke scores. P1's score comes from this laptop; P2's arrives over the
  // socket from P2's own device. Higher score wins; ties go to P1.
  const settleMatch = useCallback(async (p1Final: number, p2Final: number) => {
    if (!room || !oracle) return;
    setPhase("scoring");
    const p1Wins = p1Final >= p2Final;
    const winnerWalletStr = p1Wins ? room.players[0]?.wallet : room.players[1]?.wallet;
    if (!winnerWalletStr) { addLog("No winner wallet — can't settle"); return; }
    const winnerPubkey = new PublicKey(winnerWalletStr);
    const label = p1Wins ? "P1" : "P2";
    addLog(`Settling on-chain — ${label} wins (${p1Final} vs ${p2Final})…`);
    let payout_tx = "(settle failed)";
    let commentary = "";
    try {
      const programId = new PublicKey(oracle.program_id);
      const treasury  = new PublicKey(oracle.treasury_pubkey);
      const program   = getProgram();
      const matchId   = matchIdRef.current ?? room.code;
      const mPda      = matchPda(matchId, programId);
      const vPda      = vaultPda(matchId, programId);
      const sig = await program.methods
        .settle(matchId, winnerPubkey)
        .accounts({
          oracle: localOracle.publicKey,
          matchAccount: mPda,
          vault: vPda,
          winnerAccount: winnerPubkey,
          treasury,
          systemProgram: SystemProgram.programId,
        })
        .signers([localOracle])
        .rpc();
      payout_tx = sig;
      addLog(`✅ Settled! ${label} wins. tx=${sig.slice(0, 12)}…`);
      const margin = Math.abs(p1Final - p2Final);
      commentary = margin === 0
        ? "A dead tie — sing it again!"
        : margin <= 5
          ? `${label} squeaks it out by a hair.`
          : margin <= 20
            ? `${label} takes the win. Respectable battle.`
            : `${label} absolutely bodied that. Game over.`;
    } catch (e: any) {
      console.error("[settleMatch]", e);
      addLog(`❌ Settle failed: ${errDetail(e)}`);
      commentary = `${label} wins on points (${p1Final} vs ${p2Final}) — settle failed, check oracle balance.`;
    }
    setFinish({
      scores: [
        // P1's frame counts are known locally; P2 only sends its final score over
        // the socket, so its frame breakdown isn't available on the laptop.
        { song_id: selectedSongId, player_id: "p1", score: p1Final, frames_scored: p1Score?.scored ?? 0, frames_hit: p1Score?.hits ?? 0 },
        { song_id: selectedSongId, player_id: "p2", score: p2Final, frames_scored: 0, frames_hit: 0 },
      ],
      winner: p1Wins ? "p1" : "p2",
      commentary,
      mc_audio_url: "",
      payout_tx,
      leaderboard: [],
    });
    socket.emit("match:finished", { code: room.code, winner: p1Wins ? "p1" : "p2" });
    setPhase("finished");
  }, [room, oracle, getProgram, selectedSongId, socket, p1Score]);

  // Keep settleRef pointed at the current settleMatch so the socket "game:over"
  // handler (registered with a stale closure) always settles with fresh state.
  settleRef.current = (r: RoomState) =>
    void settleMatch(r.players[0]?.score ?? 0, r.players[1]?.score ?? 0);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;
  const winnerWallet =
    finish?.winner === "p1" ? room?.players[0].wallet
    : finish?.winner === "p2" ? room?.players[1].wallet
    : null;
  const scoreFor = (idx: 0 | 1) => finish?.scores[idx]?.score ?? null;

  return (
    <div style={styles.root}>
      <div style={styles.inner}>
        {/* Header */}
        <div style={styles.header}>
          <h1 style={styles.title}>🎤 Pitch Battle</h1>
          <WalletMultiButton />
        </div>

        {/* Lobby */}
        {phase === "lobby" && (
          <div style={{ ...styles.card, background: "#16111f", border: "1px solid #2a1f3d" }}>
            <div style={styles.cardTitle}>Wallet acting up?</div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginBottom: 12 }}>
              Skip Solana entirely and play a quick hot-seat match on this laptop — two
              singers, one mic, highest accuracy wins.
            </div>
            <a href="/local" style={{ display: "inline-block", background: "linear-gradient(135deg,#7c3aed,#6d28d9)", color: "#fff", textDecoration: "none", borderRadius: 8, padding: "10px 18px", fontSize: 14, fontWeight: 700 }}>
              🎤 Play local — no wallet →
            </a>
          </div>
        )}

        {phase === "lobby" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Create a Game</div>

            <div style={{ marginTop: 12 }}>
              <label style={styles.label}>Song</label>
              <select
                style={styles.input}
                value={selectedSongId}
                onChange={(e) => setSelectedSongId(e.target.value)}
                disabled={songs.length === 0}
              >
                {songs.length === 0 && <option>Loading…</option>}
                {songs.map((s) => (
                  <option key={s.song_id} value={s.song_id}>
                    {s.title} — {s.artist} (diff {s.difficulty})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={styles.label}>Wager (SOL)</label>
              <input
                style={styles.input}
                type="number"
                step="0.01"
                min="0.001"
                value={stakeSOL}
                onChange={(e) => setStakeSOL(e.target.value)}
              />
            </div>

            {oracle && (
              <div style={{ ...styles.label, marginBottom: 8 }}>
                Backend oracle: <span style={styles.mono}>{oracle.oracle_pubkey.slice(0, 16)}…</span>
                {" "}({oracle.escrow_mode})
              </div>
            )}


            <Btn
              onClick={createRoom}
              busy={busy}
              disabled={!wallet.publicKey || !selectedSongId}
            >
              {wallet.publicKey ? "Create Room" : "Connect Wallet First"}
            </Btn>
          </div>
        )}

        {/* Waiting */}
        {phase === "waiting" && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Share the Code</div>
            <div style={styles.bigCode}>{room.code}</div>
            {joinUrl && (
              <div style={{ display: "flex", justifyContent: "center", margin: "16px 0", background: "#fff", padding: 16, borderRadius: 12 }}>
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", marginBottom: 16, wordBreak: "break-all" }}>
              {joinUrl}
            </div>
            <div style={styles.label}>Players joined: {room.players.length} / 2</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={styles.playerRow}>
                <span style={{ color: (p.staked || (waitingForP2Stake && p.wallet === wallet.publicKey?.toBase58())) ? "#4ade80" : "#facc15" }}>
                  {(p.staked || (waitingForP2Stake && p.wallet === wallet.publicKey?.toBase58())) ? "✓ Staked" : "○ Not staked"}
                </span>{" "}{p.name} — {p.wallet.slice(0, 10)}…
              </div>
            ))}
            {room.players.length === 2 && (
              <Btn onClick={startGame} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Start Game &amp; Lock Wagers
              </Btn>
            )}
          </div>
        )}

        {/* Gaming — this laptop only sings P1's turn. P2 sings on their own device. */}
        {phase === "gaming" && room && (
          <div>
            <div style={{ ...styles.card, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={styles.cardTitle}>🎤 P1's Turn</div>
                <div style={{ color: "#6b7280", fontSize: 12, marginTop: 2 }}>
                  {room.players[0]?.wallet.slice(0, 10)}…
                </div>
              </div>
            </div>
            <Karaoke
              key="p1"
              playerLabel="P1"
              onFinish={(result: KaraokeResult) => {
                setP1Score(result);
                socket.emit("score:submit", { code: room.code, wallet: room.players[0].wallet, score: result.score });
                setPhase("waiting_p2");
                addLog(`P1 done — ${result.score}/100. Waiting for P2 to sing on their device…`);
              }}
            />
          </div>
        )}

        {/* Waiting for P2 — P1 is done; P2 sings the same song on their own device */}
        {phase === "waiting_p2" && room && p1Score && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Round 1 complete!</div>
            <div style={{ textAlign: "center", padding: "16px 0" }}>
              <div style={{ color: "#6b7280", fontSize: 13 }}>P1 scored</div>
              <div style={{
                fontSize: 72, fontWeight: 900, lineHeight: 1,
                color: p1Score.score >= 80 ? "#4ade80" : p1Score.score >= 50 ? "#facc15" : "#f87171",
              }}>{p1Score.score}</div>
              <div style={{ color: "#374151", fontSize: 12, marginTop: 4 }}>{p1Score.hits} / {p1Score.scored} frames hit</div>
            </div>
            <div style={{ color: "#9ca3af", fontSize: 14, textAlign: "center", margin: "8px 0 4px" }}>
              🎤 <b style={{ color: "#fff" }}>P2</b> is singing on their own device — hang tight, we&apos;ll settle automatically.
            </div>
          </div>
        )}

        {/* Scoring */}
        {phase === "scoring" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Scoring…</div>
            <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 8 }}>
              Backend is running pyin on both takes. Hold tight.
            </div>
          </div>
        )}

        {/* Finished */}
        {phase === "finished" && room && finish && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Game Over</div>
            {room.players.map((p, i) => {
              const s = scoreFor(i as 0 | 1);
              const isWinner = p.wallet === winnerWallet;
              return (
                <div
                  key={p.wallet}
                  style={{
                    ...styles.playerRow,
                    color: isWinner ? "#4ade80" : "#fff",
                    fontWeight: isWinner ? 700 : 400,
                  }}
                >
                  {isWinner ? "🏆 " : ""}{p.name}: {s ?? "—"}/100
                </div>
              );
            })}

            <div style={{ marginTop: 16, color: "#e5e7eb", fontSize: 14, fontStyle: "italic" }}>
              "{finish.commentary}"
            </div>

            {finish.mc_audio_url && (
              <audio
                controls
                autoPlay
                src={`${API_BASE}${finish.mc_audio_url}`}
                style={{ marginTop: 12, width: "100%" }}
              />
            )}

            <div style={{ ...styles.label, marginTop: 16 }}>Payout</div>
            <div style={styles.mono}>{finish.payout_tx}</div>
            {finish.payout_tx.length > 50 && oracle?.escrow_mode === "devnet" && (
              <a
                href={`https://explorer.solana.com/tx/${finish.payout_tx}?cluster=devnet`}
                target="_blank" rel="noreferrer"
                style={{ color: "#60a5fa", fontSize: 12 }}
              >
                view on explorer ↗
              </a>
            )}

            {finish.leaderboard?.length > 0 && (
              <>
                <div style={{ ...styles.label, marginTop: 16 }}>Leaderboard</div>
                {finish.leaderboard.slice(0, 5).map((row, i) => (
                  <div key={i} style={styles.playerRow}>
                    {row.player}: {row.wins}W / {row.losses}L
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Log */}
        <div style={{ ...styles.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={styles.label}>Log</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ color: "#555", fontSize: 12 }}>Events will appear here</div>}
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
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

const styles: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "system-ui, sans-serif", padding: 24 },
  inner: { maxWidth: 560, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 },
  title: { margin: 0, fontSize: 22, fontWeight: 700 },
  card: { background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#e5e7eb" },
  label: { color: "#6b7280", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1 },
  mono: { fontFamily: "monospace", fontSize: 12, wordBreak: "break-all" as const, color: "#e5e7eb" },
  bigCode: { fontSize: 64, fontWeight: 900, letterSpacing: 12, textAlign: "center" as const, color: "#facc15", padding: "20px 0" },
  input: { display: "block", width: "100%", background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, padding: "8px 12px", color: "#fff", fontSize: 16, marginTop: 4, marginBottom: 16 },
  playerRow: { padding: "6px 0", borderBottom: "1px solid #1a1a1a", fontSize: 14, fontFamily: "monospace" },
};

function Btn({ onClick, busy, disabled, children, color, style }: {
  onClick: () => void; busy: boolean; disabled?: boolean;
  children: React.ReactNode; color?: string; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      style={{
        background: busy || disabled ? "#222" : (color ?? "#3b82f6"),
        color: busy || disabled ? "#555" : "#fff",
        border: "none", borderRadius: 8, padding: "10px 20px",
        cursor: busy || disabled ? "not-allowed" : "pointer",
        fontSize: 14, fontWeight: 600, width: "100%",
        ...style,
      }}
    >
      {busy ? "…" : children}
    </button>
  );
}
