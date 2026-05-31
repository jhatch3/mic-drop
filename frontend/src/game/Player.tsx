import { useState, useEffect, useCallback, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getSocket } from "./socket";
import type { RoomState } from "./types";
import IDL from "../idl/pitch_battle.json";
import {
  PAL, FONT, bevelPanel, Logo, BevelBtn, Splat, Panel,
  StageBG, LowerThird, ScoreBug,
} from "@/ui";

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

  // ── Derived presentation values ───────────────────────────────────────────
  const singing = !!room && (room.state === "p1_singing" || room.state === "p2_singing");
  const inLobby = joined && !!room && room.state === "waiting" && !gameOver;
  const youAddr = wallet.publicKey?.toBase58();
  const youWon = !!finish && !!room?.winner && room.winner === youAddr;
  const isTie = finish?.winner === "tie";
  const youScore = myInfo?.score ?? null;
  const oppScore = opponentInfo?.score ?? null;
  const fmtScore = (s: number | null | undefined) => (s === null || s === undefined ? "—" : s);
  const shortAddr = youAddr ? `${youAddr.slice(0, 4)}…${youAddr.slice(-3)}` : null;

  // Phone-shell pieces shared across every state.
  const shell = (
    tag: string, tagColor: string, blink: boolean,
    body: React.ReactNode, lower: React.ReactNode,
  ) => (
    <div style={styles.root}>
      <div style={styles.phone}>
        {/* status strip */}
        <div style={styles.statusStrip}>
          <span>SECOND SCREEN</span>
          <span>▮▮▮ LIVE</span>
        </div>
        {/* compact ink bar: status chip + small logo */}
        <div style={styles.barRow}>
          <span className={blink ? "md-blink" : undefined}
            style={{ ...styles.chip, background: tagColor }}>● {tag}</span>
          <Logo scale={0.5} />
        </div>
        <StageBG>
          <div style={styles.stageInner}>{body}</div>
        </StageBG>
        {lower}
      </div>
    </div>
  );

  // ── 6 · JOIN / GUEST LIST (not joined) ────────────────────────────────────
  if (!joined) {
    const chars = code.padEnd(6, " ").slice(0, 6).split("");
    return shell(
      "GUEST LIST", PAL.cyan, false,
      <>
        <div style={styles.stageHead}>GET ON THE BILL</div>

        <Panel color={PAL.white} title="ROOM CODE" titleBg={PAL.purple} titleFg={PAL.white}>
          {/* per-char display boxes (decorative) over the working input */}
          <div style={{ display: "flex", justifyContent: "center", gap: 5, flexWrap: "wrap" }}>
            {chars.map((c, i) => (
              <span key={i} style={{
                ...bevelPanel(c.trim() ? PAL.cream : PAL.white, { shadow: 0 }),
                width: 38, height: 50, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: FONT.display, fontSize: 30,
                color: c.trim() ? PAL.purpleDp : PAL.orange,
              }}>
                {c.trim() ? c : <span className="md-blink">_</span>}
              </span>
            ))}
          </div>
          <input
            style={styles.input}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ENTER CODE"
            maxLength={6}
            aria-label="Room code"
          />
        </Panel>

        <Panel color={PAL.white} title="CONNECT WALLET" titleBg={PAL.cyanDk} titleFg={PAL.white}>
          {/* Keep WalletMultiButton logic — style its container as the broadcast CTA. */}
          <div style={styles.walletWrap}>
            <span style={styles.walletStar}>★ CONNECT PHANTOM</span>
            <WalletMultiButton />
          </div>
          <div style={styles.monoLine}>
            {shortAddr ? `${shortAddr} · connected` : "no wallet · guest play OK"}
          </div>
        </Panel>

        <div style={{ marginTop: "auto" }}>
          <Panel color={PAL.white} title="THE MC · PRE-GAME" titleBg={PAL.magenta} titleFg={PAL.white}>
            <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 16, color: PAL.ink, lineHeight: 1.2 }}>Fresh meat. Try not to flatline on the first note, rookie.</div>
          </Panel>
        </div>

        {error && <div style={styles.errorCap}>⚠ {error}</div>}
      </>,
      <LowerThird kicker="ON DECK" kickerColor={PAL.yellow} kickerFg={PAL.ink}
        headline="Connect, punch the code, you're in."
        action={
          <BevelBtn color={PAL.slime} onClick={joinRoom} disabled={code.length !== 6}>JOIN »</BevelBtn>
        } />,
    );
  }

  // ── 8 · RESULT / FINAL (game over) ────────────────────────────────────────
  if (gameOver && room) {
    const headline = finish
      ? (isTie ? "TIE" : youWon ? "YOU WON!" : "YOU LOST")
      : "SCORING…";
    const headColor = !finish ? PAL.white : isTie ? PAL.yellow : youWon ? PAL.slime : PAL.magenta;
    return shell(
      finish ? "FINAL" : "REPLAY", finish ? PAL.slime : PAL.yellow, !finish,
      <>
        <div style={{ ...styles.outcome, color: headColor }}>
          {finish ? headline : <>SCORING<span className="md-blink">…</span></>}
        </div>

        <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
          <ScoreBug big
            a={{ name: "YOU", score: finish ? fmtScore(youScore) : "—", color: PAL.slime }}
            b={{ name: "THEM", score: finish ? fmtScore(oppScore) : "—", color: PAL.magenta, fg: PAL.white }} />
        </div>

        {finish?.payout_tx && (
          <div style={{ ...bevelPanel(PAL.white), padding: "12px 14px", width: "100%", color: PAL.ink, boxSizing: "border-box" }}>
            <div style={{ fontFamily: FONT.display, fontSize: 26, color: PAL.slimeDk }}>
              {isTie ? "STAKE REFUNDED" : youWon ? "+POT" : "BETTER LUCK"}
            </div>
            <div style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.purpleDp, wordBreak: "break-all" }}>
              tx {finish.payout_tx.slice(0, 16)}… · view tx »
            </div>
          </div>
        )}

        {finish?.commentary && (
          <div style={{ width: "100%" }}>
            <Panel color={PAL.white} title="THE MC · THE VERDICT" titleBg={PAL.magenta} titleFg={PAL.white}>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 16, color: PAL.ink, lineHeight: 1.2 }}>“{finish.commentary}”</div>
            </Panel>
          </div>
        )}

        {/* per-player roster (restyled) */}
        <div style={{ width: "100%", marginTop: "auto" }}>
          {room.players.map((p) => (
            <div key={p.wallet} style={{
              ...styles.rosterRow,
              background: p.wallet === room.winner ? PAL.slime : PAL.white,
            }}>
              <span style={{ fontFamily: FONT.display }}>{p.wallet === room.winner ? "♛" : "·"}</span>
              <b style={{ fontFamily: FONT.body }}>{p.name}{p.wallet === youAddr ? " (you)" : ""}</b>
              <span style={{ marginLeft: "auto", fontFamily: FONT.mono }}>{finish ? `${fmtScore(p.score)}/100` : "—"}</span>
            </div>
          ))}
        </div>
      </>,
      <LowerThird kicker="REMATCH?" kickerColor={PAL.yellow} kickerFg={PAL.ink}
        headline={isTie ? "Tie — stakes refunded. Run it back?" : youWon ? "Run it back for double?" : "Run it back — redemption awaits."} />,
    );
  }

  // ── 7 · YOU'RE ON AIR / OPPONENT'S TURN (singing) ─────────────────────────
  if (singing) {
    const songName = (room as any)?.song?.title ?? (room as any)?.songTitle ?? null;
    if (myTurn) {
      return shell(
        "ON AIR", PAL.red, true,
        <>
          <div style={styles.onAirHead}>YOU'RE<br />ON AIR!</div>
          <Splat color={PAL.red} size={120} spin>
            <span className="md-blink" style={{ fontFamily: FONT.display, fontSize: 26, color: PAL.white, WebkitTextStroke: `1.5px ${PAL.ink}` }}>● REC</span>
          </Splat>
          <ScoreBug
            a={{ name: "YOU", score: fmtScore(youScore), color: PAL.slime }}
            b={{ name: "THEM", score: fmtScore(oppScore), color: PAL.magenta, fg: PAL.white }} />
          <div style={{ ...bevelPanel(PAL.yellow), padding: 12, width: "100%", color: PAL.ink, boxSizing: "border-box" }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 17 }}>Sing into the laptop mic — the host runs the board.</div>
          </div>
        </>,
        <LowerThird kicker={"♪ LIVE"} kickerColor={PAL.red} kickerFg={PAL.white}
          headline={songName ?? "Your turn — give 'em a show."} />,
      );
    }
    // opponent's turn — standby variant
    return shell(
      "STANDBY", PAL.cyan, true,
      <>
        <div style={{ ...styles.onAirHead, color: PAL.cyan, fontSize: 40 }}>OPPONENT'S<br />TURN</div>
        <div style={{ ...bevelPanel(PAL.white), padding: 12, width: "100%", color: PAL.ink, boxSizing: "border-box" }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 17 }}>{opponentInfo?.name ?? "Opponent"} is singing… you're on deck.</div>
        </div>
        <ScoreBug
          a={{ name: "YOU", score: fmtScore(youScore), color: PAL.slime }}
          b={{ name: "THEM", score: fmtScore(oppScore), color: PAL.magenta, fg: PAL.white }} />
      </>,
      <LowerThird kicker="STANDBY" kickerColor={PAL.cyan} kickerFg={PAL.ink}
        headline={(opponentInfo?.name ?? "Opponent") + " is on the mic."} />,
    );
  }

  // ── LOBBY (joined, waiting / checked in, standing by) ─────────────────────
  // `inLobby` marks the canonical waiting state; we also fall through here for any
  // joined-but-not-yet-classified state so the player always sees a sane standby screen.
  const lobbyHead = inLobby ? "CHECKED IN" : "STANDING BY";
  return shell(
    "ON THE LIST", PAL.orange, true,
    <>
      <div style={styles.stageHead}>{lobbyHead}</div>

      <Panel color={PAL.white} title={`ROOM ${room?.code ?? ""}`} titleBg={PAL.purple} titleFg={PAL.white}>
        <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, marginBottom: 8 }}>
          {room?.matchId ? "Host locked the wager." : "Waiting for host to start…"}
        </div>
        {(room?.players ?? []).map((p) => (
          <div key={p.wallet} style={{
            ...styles.rosterRow,
            background: p.staked ? PAL.slime : PAL.cream,
          }}>
            <span style={{ fontFamily: FONT.display, color: p.staked ? PAL.slimeDk : PAL.orangeDk }}>
              {p.staked ? "✓" : "○"}
            </span>
            <b style={{ fontFamily: FONT.body }}>{p.name}{p.wallet === youAddr ? " (you)" : ""}</b>
            <span style={{ marginLeft: "auto", fontFamily: FONT.mono }}>{p.staked ? "STAKED" : "READY?"}</span>
          </div>
        ))}
        {/* standing-by row when only one player present */}
        {(room?.players?.length ?? 0) < 2 && (
          <div style={styles.standbyRow}>
            <span className="md-blink" style={{ fontFamily: FONT.display, color: PAL.orange }}>●</span>
            standing by for challenger…
          </div>
        )}
      </Panel>

      {/* Stake action — appears once host creates the on-chain match */}
      {room?.matchId && !staked && (
        <Panel color={PAL.white} title="STAKE TO PLAY" titleBg={PAL.cyanDk} titleFg={PAL.white}>
          <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, marginBottom: 10 }}>
            Stake your SOL to lock your seat.
          </div>
          <BevelBtn color={PAL.orange} fg={PAL.white} big
            onClick={stakeOnChain} disabled={staking || !wallet.publicKey}
            style={{ width: "100%", justifyContent: "center" }}>
            {staking ? "STAKING…" : `★ STAKE ${(room.stake / 1e9).toFixed(3)} SOL`}
          </BevelBtn>
        </Panel>
      )}
      {staked && (
        <div style={{ ...bevelPanel(PAL.slime), padding: 12, color: PAL.ink, fontFamily: FONT.mono, fontSize: 16, boxSizing: "border-box" }}>
          ✓ Staked! Waiting for the show to start…
        </div>
      )}

      {error && <div style={styles.errorCap}>⚠ {error}</div>}

      <div style={{ marginTop: "auto", width: "100%" }}>
        <Panel color={PAL.white} title="THE MC · GREEN ROOM" titleBg={PAL.magenta} titleFg={PAL.white}>
          <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 16, color: PAL.ink, lineHeight: 1.2 }}>Roster's filling up. Loosen those pipes, rookie.</div>
        </Panel>
        {log[0] && (
          <div style={{ fontFamily: FONT.mono, fontSize: 14, color: PAL.cyan, marginTop: 8, textAlign: "left" }}>
            ▸ {log[0]}
          </div>
        )}
      </div>
    </>,
    <LowerThird kicker="WAITING" kickerColor={PAL.orange} kickerFg={PAL.white}
      headline={room?.matchId ? "Stake up — the host is ready to roll." : "You're checked in. Hang tight for the host."} />,
  );
}

// ─── Styles (Broadcast — early-2000s live-TV) ───────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  // Center the phone column; fluid on mobile, framed on desktop.
  root: { minHeight: "100vh", display: "flex", justifyContent: "center", alignItems: "stretch", background: PAL.purpleDp },
  phone: { width: "100%", maxWidth: 430, minHeight: "100vh", display: "flex", flexDirection: "column",
    background: PAL.purpleDp, fontFamily: FONT.body, color: PAL.white, overflow: "hidden" },
  statusStrip: { background: PAL.ink, color: PAL.slime, fontFamily: FONT.mono, fontSize: 15,
    display: "flex", justifyContent: "space-between", padding: "3px 12px", flexShrink: 0 },
  barRow: { display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", background: PAL.ink,
    borderBottom: `4px solid ${PAL.ink}`, flexShrink: 0 },
  chip: { color: PAL.white, fontFamily: FONT.display, fontSize: 13, padding: "3px 10px", letterSpacing: 1, whiteSpace: "nowrap" },
  stageInner: { flex: 1, display: "flex", flexDirection: "column", gap: 14, padding: 16, zIndex: 2, alignItems: "center", textAlign: "center" },
  stageHead: { fontFamily: FONT.display, fontSize: 26, letterSpacing: 1, color: PAL.yellow, textShadow: `2px 2px 0 ${PAL.ink}` },
  outcome: { fontFamily: FONT.display, fontSize: 50, lineHeight: 0.95, letterSpacing: 1, textShadow: `3px 3px 0 ${PAL.ink}`, transform: "rotate(-2deg)", marginTop: 6 },
  onAirHead: { fontFamily: FONT.display, fontSize: 46, color: PAL.white, letterSpacing: 1, lineHeight: 0.95,
    textShadow: `3px 3px 0 ${PAL.ink}`, transform: "rotate(-2deg)" },
  input: { display: "block", width: "100%", boxSizing: "border-box", marginTop: 10, padding: "10px 12px",
    background: PAL.cream, border: `3px solid ${PAL.ink}`, borderRadius: 0, color: PAL.purpleDp,
    fontFamily: FONT.display, fontSize: 22, letterSpacing: 6, textTransform: "uppercase", textAlign: "center", minHeight: 44 },
  walletWrap: { position: "relative", border: `3px solid ${PAL.ink}`, background: PAL.orange,
    boxShadow: `4px 4px 0 ${PAL.ink}`, minHeight: 48, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  walletStar: { position: "absolute", pointerEvents: "none", fontFamily: FONT.display, fontSize: 22,
    color: PAL.white, letterSpacing: 0.5, textTransform: "uppercase", zIndex: 0 },
  monoLine: { fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, textAlign: "center", marginTop: 8 },
  rosterRow: { display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", color: PAL.ink,
    border: `2px solid ${PAL.ink}`, marginBottom: 6, fontSize: 15, whiteSpace: "nowrap" },
  standbyRow: { display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", border: `2px dashed ${PAL.ink}`,
    color: PAL.purpleDp, fontFamily: FONT.mono, fontSize: 16 },
  errorCap: { fontFamily: FONT.mono, fontSize: 15, color: PAL.white, background: PAL.red,
    border: `2px solid ${PAL.ink}`, padding: "6px 10px", width: "100%", boxSizing: "border-box", textAlign: "left" },
};
