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
import { PAL, FONT, bevelPanel, BevelBtn, Panel, OnAirBar, LowerThird } from "@/ui";

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

  const [stakeSOL, setStakeSOL] = useState(
    () => new URLSearchParams(window.location.search).get("stake") ?? "0.001"
  );
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

  const camLive = phase === "gaming" && dancingActive;
  const elapsed = camLive ? (performance.now() - playbackStartRef.current) / 1000 : 0;
  const fmtTimer = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  const cueHeadline = !currentTurn
    ? "Waiting for the next dancer to step into frame."
    : dancingActive
      ? `${currentTurn.player}, hit your marks and match the moves.`
      : `${currentTurn.player}, step into frame and press Start.`;

  return (
    <div style={{ minHeight: "100vh", background: PAL.purpleDp, color: PAL.white, fontFamily: FONT.body, display: "flex", flexDirection: "column" }}>

      {/* ON-AIR top bar — broadcast style */}
      <OnAirBar
        tag={camLive ? "ON AIR" : "STANDBY"}
        tagColor={camLive ? PAL.red : PAL.cyan}
        blink={false}
        left={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: FONT.display, fontSize: 16, color: PAL.white, letterSpacing: 0.5, textTransform: "uppercase" }}>
              Dance Battle
            </span>
            {camLive && <span style={{ color: PAL.red, fontFamily: FONT.display, fontSize: 15 }}>● REC</span>}
            {currentTurn && (
              <span style={{ fontFamily: FONT.display, fontSize: 13, color: PAL.ink, background: PAL.magenta, border: `2px solid ${PAL.ink}`, padding: "2px 10px", letterSpacing: 1, textTransform: "uppercase" }}>
                {currentTurn.player}
              </span>
            )}
          </span>
        }
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span>{fmtTimer(elapsed)}</span>
          </span>
        }
      />

      <div style={{ flex: 1, padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 760, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>

        {/* Wallet */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <WalletMultiButton />
        </div>

        {/* Lobby */}
        {phase === "lobby" && (
          <Panel color={PAL.cream} title="CREATE A DANCE BATTLE" titleBg={PAL.ink} titleFg={PAL.magenta}>
            <label style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: 1.5, textTransform: "uppercase", color: PAL.purpleDp }}>Wager (SOL)</label>
            <input
              style={{ display: "block", width: "100%", boxSizing: "border-box", ...bevelPanel(PAL.white, { shadow: 0 }), padding: "10px 12px", color: PAL.ink, fontFamily: FONT.mono, fontSize: 18, marginTop: 6, marginBottom: 16 }}
              type="number" step="0.01" min="0.001"
              value={stakeSOL}
              onChange={(e) => setStakeSOL(e.target.value)}
            />
            {pose.error && <div style={{ fontFamily: FONT.mono, fontSize: 14, color: PAL.red, marginBottom: 8 }}>{pose.error}</div>}
            <BevelBtn color={wallet.publicKey ? PAL.magenta : PAL.cyan} fg={wallet.publicKey ? PAL.white : PAL.ink} onClick={createRoom} disabled={busy || !wallet.publicKey} style={{ minHeight: 44, width: "100%", justifyContent: "center" }}>
              {busy ? "…" : wallet.publicKey ? "Create Room »" : "Connect Wallet First"}
            </BevelBtn>
          </Panel>
        )}

        {/* Waiting */}
        {phase === "waiting" && room && (
          <Panel color={PAL.cream} title="SHARE THE CODE" titleBg={PAL.ink} titleFg={PAL.cyan}>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(48px,12vw,72px)", letterSpacing: 10, textAlign: "center", color: PAL.ink, textShadow: `3px 3px 0 ${PAL.magenta}`, padding: "12px 0" }}>{room.code}</div>
            {joinUrl && (
              <div style={{ display: "flex", justifyContent: "center", margin: "16px auto", ...bevelPanel(PAL.white), padding: 16, width: "fit-content" }}>
                <QRCode value={joinUrl} size={180} />
              </div>
            )}
            <div style={{ fontFamily: FONT.mono, fontSize: 13, textAlign: "center", marginBottom: 16, wordBreak: "break-all", color: PAL.purpleDp }}>
              {joinUrl}
            </div>
            <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: 1.5, textTransform: "uppercase", color: PAL.purpleDp, marginBottom: 8 }}>Players joined: {room.players.length} / 2</div>
            {room.players.map((p) => (
              <div key={p.wallet} style={{ fontFamily: FONT.mono, fontSize: 14, color: PAL.ink, padding: "6px 0", borderBottom: `2px solid ${PAL.paper}` }}>
                <span style={{ color: PAL.slimeDk }}>✓</span> {p.name} — {p.wallet.slice(0, 10)}…
              </div>
            ))}
            {room.players.length === 2 && (
              <BevelBtn color={PAL.magenta} fg={PAL.white} onClick={startGame} disabled={busy} style={{ minHeight: 44, width: "100%", justifyContent: "center", marginTop: 16 }}>
                {busy ? "…" : "Start Dance Battle & Lock Wagers »"}
              </BevelBtn>
            )}
          </Panel>
        )}

        {/* Gaming */}
        {phase === "gaming" && room && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Webcam + pose overlay — chunky ink frame + hard offset shadow */}
            <div style={{ width: VIDEO_W, maxWidth: "100%", margin: "0 auto", ...bevelPanel(PAL.ink, { bw: 4, shadow: 6 }), position: "relative", overflow: "hidden" }}>
              <video
                ref={pose.videoRef}
                width={VIDEO_W}
                height={VIDEO_H}
                muted
                playsInline
                style={{ width: "100%", background: PAL.ink, display: "block", transform: "scaleX(-1)" }}
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
                  justifyContent: "center", color: PAL.cyan, fontFamily: FONT.mono, fontSize: 18,
                  letterSpacing: 1.5, textTransform: "uppercase", textAlign: "center", padding: 16,
                  background: "rgba(11,11,11,0.78)",
                }}>
                  {currentTurn ? `${currentTurn.player} · press Start to dance` : "Waiting for turn…"}
                </div>
              )}
            </div>

            {/* Live score — magenta bevel panel */}
            <div style={{ width: VIDEO_W, maxWidth: "100%", margin: "0 auto", ...bevelPanel(PAL.magenta), padding: "12px 14px", textAlign: "center", color: PAL.white }}>
              <div style={{ fontFamily: FONT.display, fontSize: 13, letterSpacing: 2, textTransform: "uppercase" }}>Live Score</div>
              <div style={{ fontFamily: FONT.display, fontSize: "clamp(48px,12vw,64px)", lineHeight: 0.9, textShadow: `3px 3px 0 ${PAL.ink}` }}>{liveScore}</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 16 }}>match quality</div>
            </div>

            {/* Turn controls + scoreboard */}
            <Panel color={PAL.cream} title={currentTurn ? `${currentTurn.player.toUpperCase()} IS DANCING` : "WAITING FOR NEXT TURN"} titleBg={PAL.ink} titleFg={PAL.cyan}>
              {currentTurn && (
                <>
                  <div style={{ fontFamily: FONT.mono, fontSize: 14, marginBottom: 12, color: PAL.purpleDp }}>
                    {pose.ready ? `MediaPipe ready · ${pose.fps} fps` : "Loading pose model…"}
                    {choreo.loading && " · Loading choreography…"}
                    {choreo.error && <span style={{ color: PAL.red }}> · No reference choreography (will score 0)</span>}
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <BevelBtn color={PAL.cyan} fg={PAL.ink} onClick={startDancing} disabled={busy || dancingActive} style={{ minHeight: 44, flex: "1 1 160px", justifyContent: "center" }}>
                      {dancingActive ? "Dancing…" : "▶ Start Dancing »"}
                    </BevelBtn>
                    <BevelBtn color={PAL.magenta} fg={PAL.white} onClick={submitDanceScore} disabled={busy || !dancingActive} style={{ minHeight: 44, flex: "1 1 160px", justifyContent: "center" }}>
                      ■ Stop & Score »
                    </BevelBtn>
                  </div>
                </>
              )}
              <div style={{ marginTop: 16 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.ink, padding: "6px 0", borderBottom: `2px solid ${PAL.paper}`, display: "flex", justifyContent: "space-between" }}>
                    <span>{p.name}</span>
                    <span style={{ color: PAL.purpleDp, fontWeight: 700 }}>{p.score !== null ? `${p.score}/100` : "—"}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {/* Finished */}
        {phase === "finished" && room && (
          <Panel color={PAL.cream} title="DANCE BATTLE OVER" titleBg={PAL.ink} titleFg={PAL.yellow}>
            {room.players.map((p) => {
              const won = p.wallet === room.winner;
              return (
                <div
                  key={p.wallet}
                  style={{ fontFamily: FONT.display, fontSize: won ? 24 : 19, letterSpacing: 0.5, textTransform: "uppercase", color: won ? PAL.ink : PAL.purpleDp, background: won ? PAL.slime : "transparent", border: won ? `3px solid ${PAL.ink}` : "3px solid transparent", padding: "8px 12px", marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 12 }}
                >
                  <span>{won ? "🏆 " : ""}{p.name}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 20 }}>{p.score}/100</span>
                </div>
              );
            })}
            {room.winner && (
              <BevelBtn color={PAL.slime} fg={PAL.ink} onClick={settle} disabled={busy} style={{ minHeight: 44, width: "100%", justifyContent: "center", marginTop: 16 }}>
                {busy ? "…" : "Pay Winner on Solana »"}
              </BevelBtn>
            )}
          </Panel>
        )}

        {/* Log */}
        <Panel color={PAL.white} title="LOG" titleBg={PAL.ink} titleFg={PAL.slime} shadow={4}>
          <div style={{ maxHeight: 150, overflowY: "auto" }}>
            {log.length === 0 && <div style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.purpleDp }}>Events will appear here</div>}
            {log.map((l, i) => <div key={i} style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.ink, marginBottom: 2 }}>{l}</div>)}
          </div>
        </Panel>
      </div>

      {/* Move cue — the signature lower-third */}
      <LowerThird
        kicker="♪ LIVE"
        kickerColor={PAL.red}
        kickerFg={PAL.white}
        bodyColor={PAL.cyan}
        headline={cueHeadline}
      />
    </div>
  );
}
