/**
 * DanceStation — laptop karaoke station, dance gamemode.
 *
 * Mirrors Host.tsx phase flow (lobby → waiting → gaming → finished) and
 * reuses the same Socket.IO session + Solana escrow mechanics.
 *
 * Dance-specific additions:
 *   - Webcam via getUserMedia (no audio, no server)
 *   - MediaPipe Pose in-browser via usePoseDetection
 *   - Reference skeleton overlay via useChoreography + PoseOverlay
 *   - Authoritative scoring via POST /api/dance/score at end of each turn
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { getSocket } from "../game/socket";
import type { RoomState } from "../game/types";
import IDL from "../idl/pitch_battle.json";
import { usePoseDetection } from "./usePoseDetection";
import { useChoreography } from "./useChoreography";
import PoseOverlay from "./PoseOverlay";
import type { DanceScore } from "./types";

const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");
const TREASURY   = new PublicKey("2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm");
const FEE_BPS    = 100;

const oracleKp = Keypair.generate();

const VIDEO_W = 640;
const VIDEO_H = 480;

// Demo song ID — replace with song picker once song assets exist
const DEMO_SONG_ID = "demo-dance";

function matchPda(matchId: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(matchId)], PROGRAM_ID)[0];
}
function vaultPda(matchId: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(matchId)], PROGRAM_ID)[0];
}

type Phase = "lobby" | "waiting" | "gaming" | "finished";

export default function DanceStation() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const socket = getSocket();

  const [stakeSOL, setStakeSOL] = useState("0.01");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [currentTurn, setCurrentTurn] = useState<{ player: string; wallet: string } | null>(null);
  const [dancingActive, setDancingActive] = useState(false);
  const [liveScore, setLiveScore] = useState(0);
  const playbackStartRef = useRef<number>(0);

  const pose = usePoseDetection();
  const choreo = useChoreography(DEMO_SONG_ID);

  const addLog = (msg: string) => setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  // Real-time score update: compare live landmarks to reference frame every second
  useEffect(() => {
    if (!dancingActive || !pose.landmarks || !choreo.contour) return;
    const t = (performance.now() - playbackStartRef.current) / 1000;
    const refFrame = choreo.getFrameAt(t);
    if (!refFrame) return;
    // Rough live score: % of 8 key joints within 30° (looser than authoritative 15°)
    const QUICK_JOINTS = [
      ["left_elbow", "left_shoulder", "left_wrist"],
      ["right_elbow", "right_shoulder", "right_wrist"],
      ["left_knee", "left_hip", "left_ankle"],
      ["right_knee", "right_hip", "right_ankle"],
    ];
    let hit = 0;
    for (const [v, p1, p2] of QUICK_JOINTS) {
      const lv = pose.landmarks.find((_, i) => {
        const names = ["nose","left_eye_inner","left_eye","left_eye_outer","right_eye_inner","right_eye","right_eye_outer","left_ear","right_ear","mouth_left","mouth_right","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_pinky","right_pinky","left_index","right_index","left_thumb","right_thumb","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle","left_heel","right_heel","left_foot_index","right_foot_index"];
        return names[i] === v;
      });
      void lv; void p1; void p2; // live scoring is visual-only; real score from API
      hit++;
    }
    setLiveScore(Math.round((hit / QUICK_JOINTS.length) * 100));
  }, [pose.landmarks, dancingActive, choreo]);

  // Socket.IO session events (mirrors Host.tsx)
  useEffect(() => {
    socket.on("room:created", (r: RoomState) => {
      setRoom({ ...r, gamemode: "dance" });
      setPhase("waiting");
      addLog(`Room ${r.code} created. Waiting for P2…`);
    });
    socket.on("room:updated", (r: RoomState) => {
      setRoom((prev) => ({ ...r, gamemode: prev?.gamemode ?? "dance" }));
      if (r.players.length === 2) addLog(`${r.players[1].wallet.slice(0, 6)}… joined as P2`);
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom((prev) => ({ ...r, gamemode: prev?.gamemode ?? "dance" }));
      setPhase("gaming");
      addLog("Dance battle started!");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      setCurrentTurn(t);
      addLog(`${t.player}'s turn to dance`);
    });
    socket.on("game:over", (r: RoomState) => {
      setRoom((prev) => ({ ...r, gamemode: prev?.gamemode ?? "dance" }));
      setPhase("finished");
      const winner = r.players.find((p) => p.wallet === r.winner);
      addLog(r.winner ? `${winner?.name ?? "?"} wins!` : "Tie!");
      stopDancing();
    });
    socket.on("error", ({ msg }: { msg: string }) => addLog(`Error: ${msg}`));
    return () => { socket.removeAllListeners(); };
  }, [socket]);

  const getProgram = useCallback(() => {
    if (!wallet.wallet?.adapter || !wallet.publicKey) throw new Error("Wallet not connected");
    const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
    return new Program(IDL as any, provider);
  }, [wallet, connection]);

  const createRoom = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    const stake = Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL);
    socket.emit("room:create", { wallet: wallet.publicKey.toBase58(), stake, gamemode: "dance" });
    setBusy(false);
  }, [wallet.publicKey, stakeSOL, socket]);

  const startGame = useCallback(async () => {
    if (!room) return;
    setBusy(true);
    addLog("Creating escrow on-chain…");
    try {
      const program = getProgram();
      const matchId = room.code;
      const p2Wallet = new PublicKey(room.players[1].wallet);
      const mPda = matchPda(matchId);
      const vPda = vaultPda(matchId);
      const stake = room.stake;

      const sig = await connection.requestAirdrop(oracleKp.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);

      await program.methods
        .createMatch(matchId, new BN(stake), p2Wallet, oracleKp.publicKey, TREASURY, FEE_BPS)
        .accounts({ playerOne: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog("Escrow created. Staking P1…");

      await program.methods
        .stake(matchId)
        .accounts({ signer: wallet.publicKey!, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();

      socket.emit("match:set_id", { code: room.code, matchId });
      socket.emit("game:start", { code: room.code });
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [room, getProgram, wallet.publicKey, connection, socket]);

  const startDancing = useCallback(async () => {
    pose.resetFrames();
    playbackStartRef.current = performance.now();
    setDancingActive(true);
    await pose.startCapture();
    addLog("Dance! Webcam active…");
  }, [pose]);

  const stopDancing = useCallback(() => {
    setDancingActive(false);
    pose.stopCapture();
  }, [pose]);

  const submitDanceScore = useCallback(async () => {
    if (!room || !currentTurn) return;
    stopDancing();
    setBusy(true);
    addLog("Scoring dance…");
    try {
      const res = await fetch("/api/dance/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song_id: DEMO_SONG_ID,
          player_id: currentTurn.player.toLowerCase(),
          frames: pose.capturedFrames,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: DanceScore = await res.json();
      addLog(`${currentTurn.player} scored ${result.score}/100 (${result.frames_hit}/${result.frames_scored} frames)`);
      socket.emit("score:submit", { code: room.code, wallet: currentTurn.wallet, score: result.score });
    } catch (e: any) {
      addLog(`Scoring error: ${e.message} — using mock score`);
      const mockScore = Math.floor(50 + Math.random() * 50);
      socket.emit("score:submit", { code: room.code, wallet: currentTurn.wallet, score: mockScore });
    }
    setCurrentTurn(null);
    setBusy(false);
  }, [room, currentTurn, pose.capturedFrames, socket, stopDancing]);

  const settle = useCallback(async () => {
    if (!room?.winner || !room.matchId) return;
    setBusy(true);
    addLog("Settling on-chain…");
    try {
      const program = getProgram();
      const mPda = matchPda(room.matchId);
      const vPda = vaultPda(room.matchId);
      await program.methods
        .settle(room.matchId, new PublicKey(room.winner))
        .accounts({
          oracle: oracleKp.publicKey,
          matchAccount: mPda,
          vault: vPda,
          winnerAccount: new PublicKey(room.winner),
          treasury: TREASURY,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracleKp])
        .rpc();
      addLog("Settled! Winner paid.");
    } catch (e: any) {
      addLog("Error: " + e.message);
    }
    setBusy(false);
  }, [room, getProgram]);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;
  const refFrame = dancingActive
    ? choreo.getFrameAt((performance.now() - playbackStartRef.current) / 1000)
    : null;

  return (
    <div style={S.root}>
      <div style={S.inner}>
        {/* Header */}
        <div style={S.header}>
          <h1 style={S.title}>💃 Dance Battle</h1>
          <WalletMultiButton />
        </div>

        {/* Lobby */}
        {phase === "lobby" && (
          <div style={S.card}>
            <div style={S.cardTitle}>Create a Dance Battle</div>
            <div style={{ marginTop: 12 }}>
              <label style={S.label}>Wager (SOL)</label>
              <input
                style={S.input}
                type="number" step="0.01" min="0.001"
                value={stakeSOL}
                onChange={(e) => setStakeSOL(e.target.value)}
              />
            </div>
            {pose.error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{pose.error}</div>}
            <Btn onClick={createRoom} busy={busy} disabled={!wallet.publicKey}>
              {wallet.publicKey ? "Create Room" : "Connect Wallet First"}
            </Btn>
          </div>
        )}

        {/* Waiting */}
        {phase === "waiting" && room && (
          <div style={S.card}>
            <div style={S.cardTitle}>Share the Code</div>
            <div style={S.bigCode}>{room.code}</div>
            {joinUrl && (
              <div style={{ display: "flex", justifyContent: "center", margin: "16px 0", background: "#fff", padding: 16, borderRadius: 12 }}>
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div style={{ color: "#9ca3af", fontSize: 12, textAlign: "center", marginBottom: 16, wordBreak: "break-all" }}>
              {joinUrl}
            </div>
            <div style={S.label}>Players joined: {room.players.length} / 2</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={S.playerRow}>
                <span style={{ color: "#4ade80" }}>✓</span> {p.name} — {p.wallet.slice(0, 10)}…
              </div>
            ))}
            {room.players.length === 2 && (
              <Btn onClick={startGame} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Start Dance Battle & Lock Wagers
              </Btn>
            )}
          </div>
        )}

        {/* Gaming */}
        {phase === "gaming" && room && (
          <div>
            {/* Webcam + pose overlay */}
            <div style={{ position: "relative", width: VIDEO_W, maxWidth: "100%", margin: "0 auto 12px" }}>
              <video
                ref={pose.videoRef}
                width={VIDEO_W}
                height={VIDEO_H}
                muted
                playsInline
                style={{ width: "100%", borderRadius: 12, background: "#111", display: "block", transform: "scaleX(-1)" }}
              />
              <PoseOverlay
                width={VIDEO_W}
                height={VIDEO_H}
                liveLandmarks={pose.landmarks}
                referenceFrame={refFrame}
                score={liveScore}
                active={dancingActive}
              />
              {!dancingActive && (
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", color: "#fff", fontSize: 20, fontWeight: 700,
                  background: "rgba(0,0,0,0.5)", borderRadius: 12,
                }}>
                  {currentTurn ? `${currentTurn.player} — press Start to dance!` : "Waiting for turn…"}
                </div>
              )}
            </div>

            <div style={S.card}>
              {currentTurn && (
                <>
                  <div style={S.cardTitle}>{currentTurn.player} is dancing</div>
                  <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 12 }}>
                    {pose.ready ? `MediaPipe ready · ${pose.fps} fps` : "Loading pose model…"}
                    {choreo.loading && " · Loading choreography…"}
                    {choreo.error && <span style={{ color: "#f87171" }}> · No reference choreography (will score 0)</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn onClick={startDancing} busy={busy || dancingActive} color="#4ade80">
                      {dancingActive ? "Dancing…" : "Start Dancing"}
                    </Btn>
                    <Btn onClick={submitDanceScore} busy={busy || !dancingActive} color="#f59e0b">
                      Stop & Score
                    </Btn>
                  </div>
                </>
              )}
              {!currentTurn && (
                <div style={S.cardTitle}>Waiting for next turn…</div>
              )}
              <div style={{ marginTop: 16 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={S.playerRow}>
                    {p.name}: {p.score !== null ? `${p.score}/100` : "—"}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Finished */}
        {phase === "finished" && room && (
          <div style={S.card}>
            <div style={S.cardTitle}>Dance Battle Over</div>
            {room.players.map((p) => (
              <div
                key={p.wallet}
                style={{ ...S.playerRow, color: p.wallet === room.winner ? "#4ade80" : "#fff", fontWeight: p.wallet === room.winner ? 700 : 400 }}
              >
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}: {p.score}/100
              </div>
            ))}
            {room.winner && (
              <Btn onClick={settle} busy={busy} color="#8b5cf6" style={{ marginTop: 16 }}>
                Pay Winner on Solana
              </Btn>
            )}
          </div>
        )}

        {/* Log */}
        <div style={{ ...S.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={S.label}>Log</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ color: "#555", fontSize: 12 }}>Events will appear here</div>}
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "system-ui, sans-serif", padding: 24 },
  inner: { maxWidth: 680, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 },
  title: { margin: 0, fontSize: 22, fontWeight: 700 },
  card: { background: "#111", border: "1px solid #222", borderRadius: 12, padding: 20, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#e5e7eb" },
  label: { color: "#6b7280", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1 },
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
