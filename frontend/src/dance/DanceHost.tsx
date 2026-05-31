import { useState, useCallback, useRef, type CSSProperties } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { useGameRoom } from "../services/useGameRoom";
import { useEscrow } from "../services/useEscrow";
import { useDance } from "../services/useDance";
import { useVoiceHost } from "../game/useVoiceHost";
import PoseOverlay from "./PoseOverlay";
import { PAL, FONT, BevelBtn, Panel, Splat, Confetti, OnAirBar, StageBG, LowerThird, ScoreBug, Nameplate } from "@/ui";

const DEMO_SONG_ID = "rasputin";
const VIDEO_W = 640;
const VIDEO_H = 480;

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Epic victory fanfare, fired when the confetti shoots on the reveal.
const playVictory = () => { try { const a = new Audio(`${API_BASE}/api/sfx/victory`); a.volume = 0.9; void a.play().catch(() => {}); } catch { /* */ } };

const kicker = (c: string): CSSProperties => ({ fontFamily: FONT.display, fontSize: "clamp(20px,4vw,30px)", letterSpacing: 4, color: c, textShadow: `2px 2px 0 ${PAL.ink}` });

// Closed-caption overlay pinned to the bottom while the AI host (or you) is talking.
function Captions({ host, you }: { host: string; you: string }) {
  if (!host && !you) return null;
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50, display: "flex", flexDirection: "column", gap: 6, padding: 14, pointerEvents: "none", alignItems: "center" }}>
      {host && <div style={{ maxWidth: 780, background: PAL.ink, color: PAL.white, border: `3px solid ${PAL.magenta}`, fontFamily: FONT.body, fontWeight: 800, fontSize: 18, padding: "8px 16px", textAlign: "center", lineHeight: 1.2 }}><span style={{ color: PAL.magenta }}>🔊 THE MC&nbsp;</span>{host}</div>}
      {you && <div style={{ maxWidth: 780, background: PAL.ink, color: PAL.cyan, border: `3px solid ${PAL.cyan}`, fontFamily: FONT.mono, fontSize: 19, padding: "5px 14px", textAlign: "center" }}>🧑 {you}</div>}
    </div>
  );
}

// Rotating stall prompts — the host keeps talking through these (one per turn) until the
// scores load, so the scoring screen NEVER has dead air. NEVER reveal a winner here.
const FILLERS = [
  "Both dancers are done and the judges are counting! Keep the crowd HOT and talk continuously for a good while, no pauses: hype the dance-off, drop a couple fun facts about the track or the moves, tease how close it might be, crack a joke. Keep rolling until you're handed the result. Do NOT announce a winner yet.",
  "Keep the energy rolling non-stop — more hype, more facts, more jokes, tease the suspense. Still no winner; just keep them entertained until the scores drop.",
];

interface ScoreRow { player_id: string; score: number; }
interface FinishResponse {
  scores: ScoreRow[]; winner: "p1" | "p2" | "tie"; commentary: string;
  mc_audio_url: string; payout_tx: string; leaderboard: Array<{ player: string; wins: number; losses: number }>;
}

export default function DanceHost() {
  const wallet = useWallet();
  const [stakeSOL, setStakeSOL] = useState(
    () => new URLSearchParams(window.location.search).get("stake") ?? "0.001"
  );
  const { room, phase, log, addLog, createRoom, beginGame, submitScore } = useGameRoom();
  const { busy, createAndStake } = useEscrow(addLog);

  const [finish, setFinish] = useState<FinishResponse | null>(null);
  const [scoring, setScoring] = useState(false);

  // ── AI game-show host = the game state machine ──
  // The host's structured tool calls drive every transition:
  //   Start (button, both joined) → host enters + intro + "P1 ready?"
  //   you say ready  → host calls start_p1_turn  → P1's dance auto-starts
  //   P1 done        → host asks "P2 ready?"      → you say ready
  //   you say ready  → host calls start_p2_turn  → P2's dance auto-starts
  //   P2 done        → backend scores → host roasts + explains
  // startRef/advanceRef are placeholders until the handlers are defined below — this
  // decouples the host's onCommand from declaration order (handlers reference `voice`).
  const startRef = useRef<() => void>(() => {});
  const advanceRef = useRef<() => void>(() => {});
  const [pendingP2, setPendingP2] = useState(false);   // P1 done, awaiting host's start_p2_turn
  const pendingP2Ref = useRef(false);
  pendingP2Ref.current = pendingP2;

  // Who is dancing RIGHT NOW, driven locally (not by the server's async currentTurn) so the
  // dance + scoring fire at exactly the right moment — no race where scoring kicks off during
  // Player 2's turn.
  const [singing, setSinging] = useState<null | "p1" | "p2">(null);
  const singingRef = useRef<null | "p1" | "p2">(null);
  singingRef.current = singing;

  // Dance scores are computed client-side as each turn ends; stash them so /api/match/finish
  // can settle the wager off the authoritative dance scores.
  const p1ScoreRef = useRef<number | null>(null);
  const p2ScoreRef = useRef<number | null>(null);

  // NOTHING about the result shows automatically. The winner + scores stay hidden until the
  // host calls the reveal_scores tool (as he reads them out) → then the scoreboard loads in.
  const [scoresShown, setScoresShown] = useState(false);
  const scoresShownRef = useRef(false);
  scoresShownRef.current = scoresShown;
  const finishRef = useRef<FinishResponse | null>(null);
  finishRef.current = finish;
  const revealNowRef = useRef<() => void>(() => {});
  const revealDriverRef = useRef<(t: string) => void>(() => {});
  const countStartedRef = useRef(false);   // saw "three"/"two" — so a stray "one" can't reveal early

  // A start_*_turn tool call doesn't start the turn immediately — it would talk over the
  // music. We stash which turn to start, then launch a 3-2-1 countdown only AFTER the host
  // stops talking (onTurnComplete + audio drained), and the music starts when it hits 0.
  const pendingStartRef = useRef<null | "p1" | "p2">(null);
  const fallbackTimerRef = useRef<any>(null);            // ensures the round starts if turn_complete is odd
  const [countdown, setCountdown] = useState<number | null>(null);
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null);   // "THE WINNER IS… 3-2-1"
  const [confetti, setConfetti] = useState(false);   // 🎉 burst on the winner reveal

  // "keep talking while scoring" state.
  const scoringRef = useRef(false);                      // backend is still tallying the result
  const fillerRef = useRef(0);                           // which stall prompt we're on
  const tellFillerRef = useRef<() => void>(() => {});

  // The dance turn auto-ends when the instrumental finishes → score it, advance the game.
  const onSongEndRef = useRef<() => void>(() => {});
  const dance = useDance(DEMO_SONG_ID, () => onSongEndRef.current());

  const voice = useVoiceHost({
    onHostCaption: (t) => revealDriverRef.current(t),   // reveal scores off his spoken count
    allowSfx: () => !singingRef.current,                // no SFX while a player is dancing
    onCommand: (cmd) => {
      // Guard by game state so a stray/early tool call can't jump turns: P1 only before any
      // turn; P2 only once P1 is done and we're waiting on P2.
      let which: "p1" | "p2" | null = null;
      if (cmd === "start_game" || cmd === "start_p1_turn") {
        if (singingRef.current || pendingP2Ref.current || finishRef.current) return;
        which = "p1";
      } else if (cmd === "start_p2_turn") {
        if (!pendingP2Ref.current || singingRef.current) return;   // ignore if P1 not finished yet
        which = "p2";
      } else {
        return;   // reveal_scores / end_game: reveal is caption-driven now
      }
      pendingStartRef.current = which;
      // Normally the next turn_complete launches the countdown once the host stops talking.
      // If that signal never arrives (unusual tool/turn ordering), start anyway after a beat
      // so the game never stalls after the player says "I'm ready".
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = setTimeout(() => {
        const w = pendingStartRef.current;
        if (w) { pendingStartRef.current = null; startCountdownRef.current(w); }
      }, 6000);
    },
    onTurnComplete: () => {
      // Host just finished a spoken turn.
      // 1) A turn-start is queued → run the countdown once his audio drains (suppress mic).
      const which = pendingStartRef.current;
      if (which) {
        pendingStartRef.current = null;
        if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }
        setTimeout(() => startCountdownRef.current(which), voice.remainingAudioMs() + 200);
        return true;
      }
      // 2) Scores still loading → keep him talking with the next stall prompt (suppress mic).
      if (scoringRef.current) { tellFillerRef.current(); return true; }
      // 3) Mic ONLY opens in a "ready?" window: pre-game (awaiting Player 1's "ready") or while
      //    pendingP2 (awaiting Player 2's "ready"). Any other turn keeps the mic CLOSED.
      const awaitingReady = pendingP2Ref.current
        || (!singingRef.current && !finishRef.current && !scoresShownRef.current);
      return awaitingReady ? false : true;
    },
    gamemode: "dance",
  });

  const handleCreateRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    createRoom(wallet.publicKey.toBase58(), Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL), "dance");
  }, [wallet.publicKey, stakeSOL, createRoom]);

  // "Start" button — pressed once BOTH players have joined. This user gesture brings the
  // host in (unlocks audio); the backend auto-greets and asks if we're ready to start.
  const handleEnterHost = useCallback(() => {
    voice.connect(true);
    // Warm the scoring music bed now (first generation takes a few seconds) so it's cached
    // and ready the instant we reach the scoring screen.
    fetch(`${API_BASE}/api/sfx/scoring_music`).catch(() => {});
    fetch(`${API_BASE}/api/sfx/victory`).catch(() => {});   // pre-warm the victory fanfare
  }, [voice]);

  // Host called start_p1_turn (after hearing "ready") → begin the match and put P1 on the
  // floor. Staking is best-effort so the game always begins — never blocks on a wallet.
  const startP1 = useCallback(async () => {
    if (!room || singingRef.current) return;
    if (room.players.length >= 2) {
      try { await createAndStake(room.code, room.players[1].wallet, room.stake); }
      catch (e: any) { addLog("stake skipped: " + e.message); }
    }
    if (phase === "waiting") beginGame(room.code);   // server: game:started + turn P1
    setSinging("p1");                                 // local: render P1's floor now
    void dance.startDancing();
  }, [room, phase, createAndStake, beginGame, addLog, dance]);
  startRef.current = startP1;

  // Host called start_p2_turn (after Player 2 says ready) → put P2 on the floor. P1's score
  // was already submitted when P1 finished, so the server is already in p2 state.
  const advanceToP2 = useCallback(() => {
    setPendingP2(false);
    setSinging("p2");
    void dance.startDancing();
  }, [dance]);
  advanceRef.current = advanceToP2;

  // 3-2-1 countdown (big on screen), then actually start the turn so the music begins on "GO".
  const startCountdownRef = useRef<(which: "p1" | "p2") => void>(() => {});
  startCountdownRef.current = (which: "p1" | "p2") => {
    voice.flushAudio();   // cut any leftover host chatter — the countdown starts clean
    let n = 3;
    setCountdown(n);
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(id);
        setCountdown(null);
        if (which === "p1") void startP1(); else advanceToP2();
      } else {
        setCountdown(n);
      }
    }, 1000);
  };

  // Load the scoreboard + confetti + victory fanfare (the "one" moment).
  revealNowRef.current = () => {
    if (scoresShownRef.current) return;
    setRevealCountdown(null);
    setScoresShown(true);
    setConfetti(true);
    playVictory();
    setTimeout(() => setConfetti(false), 5000);
  };
  // The big 3-2-1 overlay + reveal are driven by the host's OWN spoken count (captions are
  // audio-timed), so the numbers and the scoreboard land exactly on his voice.
  revealDriverRef.current = (text: string) => {
    if (!finishRef.current || scoresShownRef.current) return;   // only during the reveal window
    const s = text.toLowerCase();
    if (/\bthree\b|(^|\D)3(\D|$)/.test(s)) { countStartedRef.current = true; setRevealCountdown(3); }
    else if (/\btwo\b|(^|\D)2(\D|$)/.test(s)) { countStartedRef.current = true; setRevealCountdown(2); }
    else if (/\bone\b|(^|\D)1(\D|$)/.test(s)) {
      if (!countStartedRef.current) return;   // ignore a stray "one" before the count actually started
      setRevealCountdown(1);
      setTimeout(() => revealNowRef.current(), 550);
    }
  };

  const tellFiller = useCallback(() => {
    voice.tell(FILLERS[fillerRef.current % FILLERS.length]);
    fillerRef.current += 1;
  }, [voice]);
  tellFillerRef.current = tellFiller;

  // Start the host's scoring banter + music bed IMMEDIATELY when the last dancer finishes,
  // so there's no dead air while the pose score is computed in the background.
  const beginScoring = useCallback(() => {
    if (scoringRef.current) return;
    setScoring(true);
    scoringRef.current = true;
    fillerRef.current = 0;
    setScoresShown(false);   // keep numbers hidden until the host reads them
    countStartedRef.current = false;   // fresh count for this reveal
    addLog("Scoring (tallying the dance-off)…");
    void voice.startMusic("scoring_music", 0.1);   // low bed so there's never dead air
    tellFiller();   // kick off the stall; onTurnComplete keeps him going until scores load
  }, [voice, addLog, tellFiller]);

  // Both dances scored → finish. The dance scores were computed client-side as each turn
  // ended; we send them to the backend to settle. The host is already talking (beginScoring)
  // and keeps going until the result lands.
  const finishMatch = useCallback(async () => {
    if (!room) return;
    beginScoring();   // idempotent — ensures the chatter is running

    const fd = new FormData();
    fd.append("match_id", room.matchId || room.code);
    fd.append("song_id", DEMO_SONG_ID);
    fd.append("p1_pubkey", room.players[0]?.wallet || "p1");
    fd.append("p2_pubkey", room.players[1]?.wallet || "p2");
    fd.append("stake_lamports", String(room.stake ?? 0));
    fd.append("gamemode", "dance");
    fd.append("p1_score", String(p1ScoreRef.current ?? 0));
    fd.append("p2_score", String(p2ScoreRef.current ?? 0));
    try {
      const r = await fetch(`${API_BASE}/api/match/finish`, { method: "POST", body: fd });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const res: FinishResponse = await r.json();
      const s1 = res.scores[0]?.score ?? 0, s2 = res.scores[1]?.score ?? 0;
      addLog(`Result: ${res.winner.toUpperCase()} P1 ${s1} / P2 ${s2}`);
      // Stop the filler + music BEFORE the announce so nothing talks over the reveal. The
      // result is stored but stays HIDDEN — the host reveals it on screen via reveal_scores.
      scoringRef.current = false;
      setScoring(false);
      voice.stopMusic();
      voice.flushAudio();   // drop any queued filler backlog so the announce lands NOW, not late
      setFinish(res);
      const winnerName = res.winner === "tie" ? "it's a TIE" : `Player ${res.winner === "p1" ? "1" : "2"}`;
      voice.tell(
        `The scores are in (P1 ${s1}, P2 ${s2}; players can't see them yet). One short suspense line, then `
        + `count down as three separate beats: "Three." "Two." "One!" Then in ONE line announce ${winnerName} `
        + `WINS and ONE line roasting the loser's dance moves. The scoreboard pops up on its own when you say `
        + `"One" — do NOT read the numbers out.`
      );
      // Safety net: if the host never counts, reveal anyway so we don't hang.
      setTimeout(() => revealNowRef.current(), 16000);
    } catch (e: any) {
      scoringRef.current = false;
      setScoring(false);
      voice.stopMusic();
      addLog("scoring failed: " + e.message);
      voice.tell("Uh oh, the scoreboard glitched for a second — recover smoothly and tell the crowd we'll get it sorted!");
    }
  }, [room, addLog, voice, beginScoring]);

  // A turn's song ended → score the dance. Driven by the LOCAL `singing` stage, not the
  // server's currentTurn, so there's no race. P1 holds for the "Player 2, ready?" gate;
  // P2 triggers the finish.
  onSongEndRef.current = useCallback(() => {
    const who = singingRef.current;
    if (!who || !room) return;
    const idx = who === "p1" ? 0 : 1;
    // Talk to the crowd RIGHT NOW; score the dance in the BACKGROUND so the host never goes
    // silent waiting on the pose score (that was the pause).
    if (who === "p1") {
      setSinging(null);
      setPendingP2(true);
      voice.tell("Player 1 just finished their dance! In ONE short line, give Player 1 a light, GENERIC bit of "
        + "encouragement and challenge Player 2 — exactly like: \"Player 1, nice moves! Player 2, you think you "
        + "can out-dance that?\" The scores are NOT in yet, so keep it generic, do NOT claim a specific score, "
        + "that they nailed it, or 'set a high bar'. That line IS your cue to Player 2; when Player 2 answers "
        + "yes, call start_p2_turn.");
      void (async () => {
        const score = await dance.stopAndScore("P1");
        p1ScoreRef.current = score;
        addLog(`P1 scored ${score}/100`);
        submitScore(room.players[0].wallet, score);
      })();
    } else {
      setSinging(null);
      beginScoring();   // host starts the scoring banter + music immediately
      void (async () => {
        const score = await dance.stopAndScore("P2");
        p2ScoreRef.current = score;
        addLog(`P2 scored ${score}/100`);
        submitScore(room.players[1].wallet, score);
        await finishMatch();
      })();
    }
  }, [room, dance, addLog, submitScore, voice, beginScoring, finishMatch]);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;
  const refFrame = dance.getCurrentRefFrame();
  const page: CSSProperties = { position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", flexDirection: "column", background: PAL.purpleDp, fontFamily: FONT.body };
  const center: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: "40px 20px", textAlign: "center" };

  // 3-2-1 countdown takes over the whole screen so the music never starts under the host's
  // voice — it begins only when this hits "GO". No blinking.
  if (countdown !== null) {
    return (
      <div style={page}>
        <OnAirBar home="/dance" tag="ON AIR" tagColor={PAL.red} blink={false} right="ROUND 1 · LIVE" />
        <StageBG>
          <div style={center}>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(14px,2.4vw,22px)", letterSpacing: 6, color: PAL.cyan, textShadow: `2px 2px 0 ${PAL.ink}` }}>GET READY TO DANCE</div>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(120px,30vw,300px)", lineHeight: 0.9, color: PAL.magenta, WebkitTextStroke: `4px ${PAL.ink}`, textShadow: `8px 8px 0 ${PAL.ink}` }}>{countdown}</div>
          </div>
        </StageBG>
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  // Winner reveal countdown — "THE WINNER IS… 3-2-1", then the board loads (scoresShown).
  if (revealCountdown !== null) {
    return (
      <div style={page}>
        <OnAirBar home="/dance" tag="FINAL" tagColor={PAL.slime} blink={false} right="MIC DROP DANCE · THE VERDICT" />
        <StageBG>
          <div style={center}>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(18px,3.4vw,30px)", letterSpacing: 5, color: PAL.cyan, textShadow: `2px 2px 0 ${PAL.ink}` }}>THE WINNER IS…</div>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(120px,30vw,300px)", lineHeight: 0.9, color: PAL.magenta, WebkitTextStroke: `4px ${PAL.ink}`, textShadow: `8px 8px 0 ${PAL.ink}` }}>{revealCountdown}</div>
          </div>
        </StageBG>
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  // Someone is on the floor: hand the whole screen to the live dance station (music + webcam
  // auto-start). The host + countdown drives it now — no manual start/stop buttons.
  if (singing && room) {
    return (
      <div style={page}>
        <OnAirBar home="/dance" tag="ON AIR" tagColor={PAL.red} blink={false} right="MIC DROP DANCE · ON THE FLOOR" />
        <StageBG>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: "32px 18px", width: "100%", maxWidth: 880, margin: "0 auto" }}>
            <Nameplate kicker="NOW DANCING" name={singing === "p1" ? "PLAYER 1" : "PLAYER 2"} color={PAL.magenta} sub="LIVE" />
            <div style={{ position: "relative", width: VIDEO_W, maxWidth: "100%", border: `4px solid ${PAL.ink}`, boxShadow: `6px 6px 0 ${PAL.ink}`, background: PAL.ink }}>
              <video
                ref={dance.videoRef} width={VIDEO_W} height={VIDEO_H} muted playsInline
                style={{ width: "100%", borderRadius: 0, background: "#111", display: "block", transform: "scaleX(-1)" }}
              />
              <PoseOverlay
                width={VIDEO_W} height={VIDEO_H}
                liveLandmarks={dance.landmarks} referenceFrame={refFrame}
                score={dance.liveScore} active={dance.dancingActive}
              />
            </div>
            <Panel color={PAL.white} title={`${singing === "p1" ? "PLAYER 1" : "PLAYER 2"} IS DANCING`}
              titleBg={PAL.ink} titleFg={PAL.magenta} style={{ width: "100%", maxWidth: VIDEO_W }}>
              <div style={{ fontFamily: FONT.mono, fontSize: 14, color: PAL.purpleDp }}>
                {dance.poseReady ? `MediaPipe ready · ${dance.fps} fps` : "Loading pose model…"}
                {dance.choreoLoading && " · Loading choreography…"}
                {dance.choreoError && <span style={{ color: PAL.red }}> · No reference (will score 0)</span>}
              </div>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.ink, borderTop: `2px solid ${PAL.ink}22`, padding: "5px 0", display: "flex", justifyContent: "space-between" }}>
                    <span>{p.name}</span><b>{p.score !== null ? `${p.score}/100` : "—"}</b>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </StageBG>
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  // Between turns: P1 danced, host is asking if Player 2 is ready. Hold here until the host
  // calls start_p2_turn (advanceToP2) — don't show the floor yet.
  if (pendingP2 && room) {
    return (
      <div style={page}>
        <OnAirBar home="/dance" tag="UP NEXT" tagColor={PAL.yellow} blink={false} right="MIC DROP DANCE · CHANGEOVER" />
        <StageBG>
          <div style={center}>
            <Nameplate kicker="UP NEXT" name="PLAYER 2" color={PAL.magenta} />
            <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, color: PAL.white, maxWidth: 520 }}>
              Tell the host when you're ready, and your routine starts on the count.
            </div>
          </div>
        </StageBG>
        <LowerThird
          kicker={voice.listening ? "LISTENING 🔊" : "ON DECK"}
          kickerColor={voice.listening ? PAL.slime : PAL.cyan} kickerFg={PAL.ink}
          headline={voice.listening ? "Say “I'm ready!” and Player 2 is up." : "The MC is talking — get set, Player 2."}
          bodyColor={PAL.cyan} />
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  const bar = phase === "lobby" || phase === "waiting"
    ? { tag: "STANDBY", color: PAL.cyan, right: "MIC DROP DANCE · GREEN ROOM" }
    : scoring && !finish
      ? { tag: "REPLAY", color: PAL.yellow, right: "MIC DROP DANCE · JUDGES' ROOM" }
      : { tag: "FINAL", color: PAL.slime, right: "MIC DROP DANCE · THE VERDICT" };

  return (
    <div style={page}>
      <OnAirBar home="/dance" tag={bar.tag} tagColor={bar.color} blink={false} right={bar.right}
        left={<div style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: FONT.logo, fontSize: 18, color: PAL.magenta, WebkitTextStroke: `1.5px ${PAL.ink}`, transform: "rotate(-3deg)" }}>DANCE</span>
          <WalletMultiButton />
        </div>} />
      <StageBG>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: "32px 18px", width: "100%", maxWidth: 880, margin: "0 auto" }}>

          {phase === "lobby" && (
            <>
              <div style={kicker(PAL.cyan)}>TONIGHT'S DANCE-OFF</div>
              <Panel color={PAL.white} title="SET THE BILL" titleBg={PAL.magenta} titleFg={PAL.white} style={{ width: "100%", maxWidth: 420 }}>
                <label style={{ fontFamily: FONT.display, fontSize: 14, letterSpacing: 1, color: PAL.ink }}>WAGER (SOL)</label>
                <input type="number" step="0.001" min="0.001" value={stakeSOL} onChange={(e) => setStakeSOL(e.target.value)}
                  style={{ width: "100%", marginTop: 6, background: PAL.cream, border: `3px solid ${PAL.ink}`, borderRadius: 0, fontFamily: FONT.mono, fontSize: 20, padding: "10px 12px", color: PAL.ink }} />
                {dance.poseError && (
                  <div style={{ marginTop: 10, fontFamily: FONT.mono, fontSize: 14, color: PAL.white, background: PAL.red, border: `3px solid ${PAL.ink}`, padding: "6px 10px" }}>{dance.poseError}</div>
                )}
              </Panel>
            </>
          )}

          {phase === "waiting" && room && (
            <>
              <div style={kicker(PAL.cyan)}>CALL IN TO COMPETE</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                <Panel color={PAL.white} title="ROOM CODE" titleBg={PAL.magenta} titleFg={PAL.white} bodyStyle={{ textAlign: "center" }}>
                  <div style={{ fontFamily: FONT.display, fontSize: "clamp(48px,12vw,84px)", letterSpacing: 8, color: PAL.ink, lineHeight: 0.95 }}>{room.code}</div>
                  <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp, wordBreak: "break-all" }}>{joinUrl}</div>
                </Panel>
                {joinUrl && (
                  <Panel color={PAL.white} title="OR SCAN" titleBg={PAL.cyanDk} titleFg={PAL.white}>
                    <div style={{ background: "#fff", padding: 8, border: `3px solid ${PAL.ink}` }}><QRCode value={joinUrl} size={150} /></div>
                  </Panel>
                )}
              </div>
              <Panel color={PAL.white} title={`ROSTER · ${room.players.length} / 2 CHECKED IN`} titleBg={PAL.ink} titleFg={PAL.cyan} style={{ width: "100%", maxWidth: 480 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.cyanDk, borderBottom: `2px solid ${PAL.ink}22`, padding: "5px 0" }}>
                    <span style={{ color: PAL.cyanDk }}>✓</span> {p.name} — {p.wallet.slice(0, 10)}…
                  </div>
                ))}
                {room.players.length < 2 && <div style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.orangeDk, padding: "5px 0" }}>● standing by for challenger…</div>}
              </Panel>
            </>
          )}

          {phase === "finished" && room && scoring && !finish && (
            <>
              <div style={{ fontFamily: FONT.display, fontSize: "clamp(32px,7vw,56px)", color: PAL.white, textShadow: `4px 4px 0 ${PAL.ink}`, textAlign: "center" }}>INSTANT REPLAY…</div>
              <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: "clamp(16px,2.4vw,21px)", color: PAL.white, maxWidth: 600, textAlign: "center" }}>
                Both dancers are off the floor — the MC's deliberating while the judges count every move.
              </div>
              <div style={{ width: "100%", maxWidth: 560, height: 18, border: `3px solid ${PAL.ink}`, background: PAL.white, overflow: "hidden" }}>
                <div style={{ height: "100%", width: "70%", background: `repeating-linear-gradient(45deg, ${PAL.magenta} 0 12px, ${PAL.cyan} 12px 24px)` }} />
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.cyan }}>scoring the choreography — the MC's keeping the crowd warm…</div>
            </>
          )}

          {phase === "finished" && room && finish && (
            !scoresShown ? (
              <div style={{ fontFamily: FONT.display, fontSize: "clamp(22px,5vw,40px)", letterSpacing: 2, color: PAL.white, textShadow: `3px 3px 0 ${PAL.ink}`, textAlign: "center" }}>🔊 THE MC IS REVEALING THE RESULTS…</div>
            ) : (
              <>
                <div style={kicker(PAL.cyan)}>YOUR WINNER</div>
                <div style={{ fontFamily: FONT.display, fontSize: "clamp(40px,9vw,92px)", color: PAL.white, WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `5px 5px 0 ${PAL.ink}`, transform: "rotate(-1deg)", lineHeight: 0.95, textAlign: "center" }}>
                  {finish.winner === "tie" ? "IT'S A TIE" : (finish.winner === "p1" ? room.players[0]?.name : room.players[1]?.name)?.toUpperCase()}
                </div>
                <ScoreBug big
                  a={{ name: room.players[0]?.name ?? "P1", score: finish.scores[0]?.score ?? 0, color: finish.winner === "p1" ? PAL.slime : PAL.white }}
                  b={{ name: room.players[1]?.name ?? "P2", score: finish.scores[1]?.score ?? 0, color: finish.winner === "p2" ? PAL.slime : PAL.magenta, fg: finish.winner === "p2" ? PAL.ink : PAL.white }} />
                {finish.winner !== "tie" && finish.payout_tx && (
                  <Splat color={PAL.yellow} size={130} style={{ fontFamily: FONT.display, fontSize: 14, color: PAL.ink, padding: 10, transform: "rotate(-6deg)" }}>
                    PAID ✓<br /><span style={{ fontFamily: FONT.mono, fontSize: 11 }}>{finish.payout_tx.slice(0, 14)}…</span>
                  </Splat>
                )}
                {finish.commentary && (
                  <Panel color={PAL.white} title="THE MC · THE VERDICT" titleBg={PAL.magenta} titleFg={PAL.white} style={{ maxWidth: 600, width: "100%" }}>
                    <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: "clamp(16px,2.4vw,21px)", color: PAL.ink, lineHeight: 1.2 }}>“{finish.commentary}”</div>
                  </Panel>
                )}
              </>
            )
          )}

          {(phase === "lobby" || phase === "waiting") && (
            <Panel color={PAL.ink} title="DIRECTOR'S LOG" titleBg={PAL.magenta} titleFg={PAL.white} shadow={4} style={{ width: "100%", maxWidth: 560 }} bodyStyle={{ maxHeight: 110, overflowY: "auto" }}>
              {log.length === 0
                ? <div style={{ fontFamily: FONT.mono, fontSize: 13, color: `${PAL.cyan}88` }}>events will appear here</div>
                : log.map((l, i) => <div key={i} style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.cyan }}>{l}</div>)}
            </Panel>
          )}
        </div>
      </StageBG>

      {phase === "lobby" && (
        <LowerThird kicker="GO LIVE" kickerColor={PAL.magenta} kickerFg={PAL.white}
          headline="Lock the wager, then put it on the floor." bodyColor={PAL.cyan}
          action={<BevelBtn color={PAL.magenta} fg={PAL.white} onClick={handleCreateRoom} disabled={busy || !wallet.publicKey}>{wallet.publicKey ? "GO LIVE »" : "CONNECT WALLET"}</BevelBtn>} />
      )}
      {phase === "waiting" && (
        <LowerThird
          kicker={voice.connected ? (voice.listening ? "LISTENING 🔊" : "ON AIR") : "WAITING"}
          kickerColor={voice.connected ? PAL.slime : PAL.orange} kickerFg={PAL.ink}
          headline={!voice.connected
            ? "Challenger checks in, then go live — the MC's got material."
            : voice.listening ? "Say “I'm ready!” to kick it off." : "The AI host is hyping up the room…"}
          bodyColor={PAL.cyan}
          action={!voice.connected ? <BevelBtn color={PAL.magenta} fg={PAL.white} onClick={handleEnterHost} disabled={!room || room.players.length < 2}>{room && room.players.length < 2 ? "WAITING…" : "START »"}</BevelBtn> : undefined} />
      )}
      {phase === "finished" && (
        <LowerThird kicker="THE MC 🔊" kickerColor={PAL.magenta} kickerFg={PAL.white}
          headline={finish && scoresShown ? "That's the show. Run it back?" : "Reviewing every move. Counting the SOL. Sharpening the burns."}
          bodyColor={PAL.cyan}
          action={<BevelBtn color={PAL.orange} onClick={() => window.location.reload()}>REMATCH »</BevelBtn>} />
      )}

      {confetti && <Confetti />}
      <Captions host={voice.hostCaption} you={voice.youCaption} />
    </div>
  );
}
