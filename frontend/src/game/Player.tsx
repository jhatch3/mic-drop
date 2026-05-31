import { useState, useEffect, useCallback, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getSocket } from "./socket";
import type { RoomState } from "./types";
import IDL from "../idl/pitch_battle.json";

const PROGRAM_ID = new PublicKey("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");

function matchPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("match"), Buffer.from(id)], PROGRAM_ID)[0];
}
function vaultPda(id: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(id)], PROGRAM_ID)[0];
}

interface FinishPayload {
  room: RoomState;
  winner: "p1" | "p2" | "tie";
  payout_tx: string;
  mc_audio_url: string;
  commentary: string;
}

export default function Player() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const socket = getSocket();

  // Generate a stable guest ID for this session (no wallet needed)
  const guestId = useMemo(() => "guest-" + Math.random().toString(36).slice(2, 10), []);

  // Pre-fill code from URL ?code=PITCH1
  const urlCode = new URLSearchParams(window.location.search).get("code") ?? "";
  const [code, setCode] = useState(urlCode.toUpperCase());
  const [room, setRoom] = useState<RoomState | null>(null);
  const [joined, setJoined] = useState(false);
  const [myTurn, setMyTurn] = useState(false);
  const [turnDone, setTurnDone] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [finish, setFinish] = useState<FinishPayload | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [staking, setStaking] = useState(false);
  const [staked, setStaked] = useState(false);

  const addLog = (msg: string) => setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);

  useEffect(() => {
    socket.on("room:updated", (r: RoomState) => {
      setRoom(r);
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom(r);
      addLog("Game started! Get ready.");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      if (t.wallet === guestId) {
        setMyTurn(true);
        setTurnDone(false);
        addLog("You're up — sing on the laptop!");
      } else {
        setMyTurn(false);
        addLog(`${t.player} is up…`);
      }
    });
    socket.on("game:over", (r: RoomState) => {
      // Authoritative result still incoming via match:finished — show scoring banner.
      setRoom(r);
      setGameOver(true);
      setMyTurn(false);
      addLog("Both takes recorded. Scoring on backend…");
    });
    socket.on("match:finished", (p: FinishPayload) => {
      setFinish(p);
      setRoom(p.room);
      setGameOver(true);
      setMyTurn(false);
      const youWon = p.room.winner && p.room.winner === wallet.publicKey?.toBase58();
      addLog(p.winner === "tie" ? "Tie! Stakes refunded." : youWon ? "You won!" : "You lost.");
    });
    socket.on("error", ({ msg }: { msg: string }) => {
      setError(msg);
      addLog("Error: " + msg);
    });

    return () => { socket.removeAllListeners(); };
  }, [socket, guestId]);

  const stakeOnChain = useCallback(async () => {
    if (!wallet.publicKey || !wallet.wallet?.adapter || !room?.matchId) return;
    setStaking(true);
    addLog("Staking on-chain — approve in Phantom…");
    try {
      const provider = new AnchorProvider(connection, wallet.wallet.adapter as any, { commitment: "confirmed" });
      const program = new Program(IDL as any, provider);
      const mPda = matchPda(room.matchId);
      const vPda = vaultPda(room.matchId);
      const sig = await program.methods
        .stake(room.matchId)
        .accounts({ signer: wallet.publicKey, matchAccount: mPda, vault: vPda, systemProgram: SystemProgram.programId })
        .rpc();
      addLog(`Staked ✓ (${sig.slice(0, 12)}…)`);
      setStaked(true);
      socket.emit("player:staked", { code: room.code, wallet: wallet.publicKey.toBase58() });
    } catch (e: any) {
      addLog("Stake failed: " + e.message);
      setError(e.message);
    }
    setStaking(false);
  }, [wallet, connection, room, socket]);

  const joinRoom = () => {
    if (!code) return;
    setError("");
    socket.emit("room:join", { code: code.toUpperCase(), wallet: guestId });
    setJoined(true);
    addLog(`Joining room ${code}…`);
  };

  const myInfo = room?.players.find((p) => p.wallet === guestId);
  const opponentInfo = room?.players.find((p) => p.wallet !== guestId);
  // Device model: the phone is a CONTROLLER only — it links your account (wallet) and
  // readies up. All singing + pitch + lyrics happen on the laptop karaoke station; no
  // audio ever leaves the phone. So there is no Karaoke render here.

  return (
    <div style={styles.root}>
      <div style={styles.inner}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={styles.title}>🎤 Pitch Battle</h1>
        </div>

        {/* Join form */}
        {!joined && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Join a Game</div>
            <label style={styles.label}>Room Code</label>
            <input
              style={styles.input}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. PITCH1"
              maxLength={6}
            />
            {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <Btn onClick={joinRoom} disabled={code.length !== 6}>
              Join Game
            </Btn>
          </div>
        )}

        {/* Waiting for game to start */}
        {joined && room && room.state === "waiting" && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>Lobby</div>
            <div style={styles.bigCode}>{room.code}</div>
            <div style={{ marginTop: 12, marginBottom: 16 }}>
              <div style={styles.label}>Players</div>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  <span style={{ color: p.staked ? "#4ade80" : "#facc15" }}>
                    {p.staked ? "✓ Staked" : "○ Not staked"}
                  </span>{" "}
                  {p.name} {p.wallet === wallet.publicKey?.toBase58() ? "(you)" : ""}
                </div>
              ))}
            </div>

            {/* Stake button — appears once host creates the on-chain match */}
            {room.matchId && !staked && (
              <div>
                <div style={{ color: "#facc15", fontSize: 13, marginBottom: 10 }}>
                  Host locked the wager. Stake your SOL to join!
                </div>
                <Btn onClick={stakeOnChain} disabled={staking || !wallet.publicKey}>
                  {staking ? "Staking…" : `Stake ${(room.stake / 1e9).toFixed(3)} SOL`}
                </Btn>
              </div>
            )}
            {staked && (
              <div style={{ color: "#4ade80", fontSize: 14, textAlign: "center", marginTop: 8 }}>
                ✓ Staked! Waiting for game to start…
              </div>
            )}
            {!room.matchId && (
              <div style={{ color: "#6b7280", fontSize: 13, textAlign: "center" }}>
                Waiting for host to start…
              </div>
            )}
          </div>
        )}

        {/* Game in progress */}
        {joined && room && (room.state === "p1_singing" || room.state === "p2_singing") && (
          <div style={styles.card}>
            {myTurn ? (
              <>
                <div style={{ ...styles.cardTitle, color: "#4ade80", fontSize: 20 }}>You're up! 🎤</div>
                <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
                  Head to the laptop and sing — pitch &amp; lyrics are scored there.
                </div>
                <div style={styles.pulse} />
              </>
            ) : (
              <>
                <div style={styles.cardTitle}>Opponent's Turn</div>
                <div style={{ color: "#9ca3af", fontSize: 14, margin: "12px 0" }}>
                  {opponentInfo?.name ?? "Opponent"} is singing…
                </div>
              </>
            )}
            <div style={{ marginTop: 20 }}>
              {room.players.map((p) => (
                <div key={p.wallet} style={styles.playerRow}>
                  {p.name} {p.wallet === guestId ? "(you)" : ""}:{" "}
                  {p.score !== null ? `${p.score}/100` : "—"}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Game over */}
        {gameOver && room && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>{finish ? "Game Over" : "Scoring…"}</div>
            {room.players.map((p) => (
              <div
                key={p.wallet}
                style={{
                  ...styles.playerRow,
                  color: p.wallet === room.winner ? "#4ade80" : "#fff",
                  fontWeight: p.wallet === room.winner ? 700 : 400,
                  fontSize: 18,
                  padding: "10px 0",
                }}
              >
                {p.wallet === room.winner ? "🏆 " : ""}{p.name}{p.wallet === wallet.publicKey?.toBase58() ? " (you)" : ""}: {finish ? `${p.score}/100` : "—"}
              </div>
            ))}
            {finish && finish.winner === "tie" && (
              <div style={{ color: "#facc15", fontWeight: 700, fontSize: 16, marginTop: 12, textAlign: "center" }}>
                Tie — stakes refunded.
              </div>
            )}
            {finish && room.winner === wallet.publicKey?.toBase58() && (
              <div style={{ color: "#4ade80", fontWeight: 700, fontSize: 18, marginTop: 12, textAlign: "center" }}>
                🎉 You won!
              </div>
            )}
            {finish?.commentary && (
              <div style={{ color: "#9ca3af", fontSize: 13, marginTop: 12, fontStyle: "italic" }}>
                "{finish.commentary}"
              </div>
            )}
            {finish?.payout_tx && (
              <div style={{ color: "#6b7280", fontSize: 11, marginTop: 8, wordBreak: "break-all" }}>
                tx: {finish.payout_tx}
              </div>
            )}
          </div>
        )}

        {/* Log */}
        <div style={{ ...styles.card, background: "#0f0f0f", marginTop: 8 }}>
          <div style={styles.label}>Events</div>
          <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto" }}>
            {log.map((l, i) => <div key={i} style={{ fontSize: 12, color: "#9ca3af", marginBottom: 2 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  // Transparent so the global synthwave backdrop + scanlines show through.
  root: { minHeight: "100vh", color: "#f7f0ff", fontFamily: "var(--font-body)", padding: 20, position: "relative", zIndex: 10 },
  inner: { maxWidth: 420, margin: "0 auto" },
  title: { margin: "0 0 16px", fontSize: 16, fontFamily: "var(--font-display)", color: "#ff2e97", textShadow: "0 0 8px #ff2e97, 0 0 22px #ff2e97" },
  card: { background: "rgba(22,10,43,0.8)", border: "1px solid #3a2168", borderRadius: 12, padding: 20, marginBottom: 12, backdropFilter: "blur(4px)", boxShadow: "0 0 0 1px #ff2e9755, 0 0 16px #ff2e9733" },
  cardTitle: { fontSize: 12, fontFamily: "var(--font-display)", marginBottom: 10, color: "#f7f0ff", textTransform: "uppercase" as const, letterSpacing: 1 },
  label: { color: "#b9a7e6", fontSize: 10, fontFamily: "var(--font-display)", textTransform: "uppercase" as const, letterSpacing: 1 },
  bigCode: { fontSize: 40, fontFamily: "var(--font-display)", letterSpacing: 6, textAlign: "center" as const, color: "#05d9e8", textShadow: "0 0 12px #05d9e8", padding: "16px 0" },
  input: { display: "block", width: "100%", background: "#160a2b", border: "1px solid #3a2168", borderRadius: 8, padding: "12px 14px", color: "#f7f0ff", fontSize: 24, fontFamily: "var(--font-body)", letterSpacing: 6, textTransform: "uppercase" as const, marginTop: 6, marginBottom: 12, textAlign: "center" as const },
  playerRow: { padding: "8px 0", borderBottom: "1px solid #3a216855", fontSize: 16, fontFamily: "ui-monospace, monospace" },
  pulse: { width: 80, height: 80, borderRadius: "50%", background: "#ff2e9733", border: "3px solid #ff2e97", margin: "20px auto", boxShadow: "0 0 22px #ff2e97", animation: "pulse 1s infinite" },
};

function Btn({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? "#241544" : "linear-gradient(100deg,#ff2e97,#b537f2)",
        color: disabled ? "#6b5b8e" : "#fff",
        border: "none", borderRadius: 10, padding: "13px 20px",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 12, fontFamily: "var(--font-display)", textTransform: "uppercase" as const, letterSpacing: 1,
        width: "100%", boxShadow: disabled ? "none" : "0 0 18px #ff2e9766",
      }}
    >
      {children}
    </button>
  );
}
