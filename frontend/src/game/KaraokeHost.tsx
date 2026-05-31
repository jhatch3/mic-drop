import { useState, useCallback, useEffect, useRef, type CSSProperties } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import QRCode from "react-qr-code";
import { useGameRoom } from "../services/useGameRoom";
import { useEscrow } from "../services/useEscrow";
import { useVoiceHost } from "./useVoiceHost";
import Karaoke, { type KaraokeResult } from "./Karaoke";
import { PAL, FONT, BevelBtn, Panel, Splat, Confetti, OnAirBar, StageBG, LowerThird, ScoreBug, Nameplate } from "@/ui";

const kicker = (c: string): CSSProperties => ({ fontFamily: FONT.display, fontSize: "clamp(20px,4vw,30px)", letterSpacing: 4, color: c, textShadow: `2px 2px 0 ${PAL.ink}` });

// Closed-caption overlay pinned to the bottom while the AI host (or you) is talking.
function Captions({ host, you }: { host: string; you: string }) {
  if (!host && !you) return null;
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 50, display: "flex", flexDirection: "column", gap: 6, padding: 14, pointerEvents: "none", alignItems: "center" }}>
      {host && <div style={{ maxWidth: 780, background: PAL.ink, color: PAL.white, border: `3px solid ${PAL.magenta}`, fontFamily: FONT.body, fontWeight: 800, fontSize: 18, padding: "8px 16px", textAlign: "center", lineHeight: 1.2 }}><span style={{ color: PAL.magenta }}>🔊 THE MC&nbsp;</span>{host}</div>}
      {you && <div style={{ maxWidth: 780, background: PAL.ink, color: PAL.slime, border: `3px solid ${PAL.slime}`, fontFamily: FONT.mono, fontSize: 19, padding: "5px 14px", textAlign: "center" }}>🧑 {you}</div>}
    </div>
  );
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const SONG_ID = "firework";

// Epic victory fanfare, fired when the confetti shoots on the reveal.
const playVictory = () => { try { const a = new Audio(`${API_BASE}/api/sfx/victory`); a.volume = 0.9; void a.play().catch(() => {}); } catch { /* */ } };

// Rotating stall prompts — the host keeps talking through these (one per turn) until the
// scores load, so the scoring screen NEVER has dead air. Each asks for a longer, continuous
// run of banter so there's no silence between turns. NEVER reveal a winner here.
// Continuous stall prompts. We send ONE and let the host talk for a good stretch (fewer
// turn-startup gaps = no pausing). The moment scores land we flushAudio() and cut to the
// announce, so a long run can't lag — it just gets interrupted cleanly.
const FILLERS = [
  "Both singers are done and the judges are counting! Keep the crowd HOT and talk continuously for a good while, no pauses: hype the showdown, drop a couple fun facts about the song or artist, tease how close it might be, crack a joke. Keep rolling until you're handed the result. Do NOT announce a winner yet.",
  "Keep the energy rolling non-stop — more hype, more facts, more jokes, tease the suspense. Still no winner; just keep them entertained until the scores drop.",
];

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
  const { room, phase, log, addLog, createRoom, beginGame, submitScore } = useGameRoom();
  const { busy, createAndStake } = useEscrow(addLog);

  // Recorded takes → scored together on the backend (80% lyrics + 20% pitch).
  const takesRef = useRef<{ p1?: Blob; p2?: Blob }>({});
  const [finish, setFinish] = useState<FinishResponse | null>(null);
  const [scoring, setScoring] = useState(false);

  // ── AI game-show host = the game state machine ──
  // The host's structured tool calls drive every transition:
  //   Start Game (button, both joined) → host enters + intro + "P1 ready?"
  //   you say ready  → host calls start_p1_turn  → P1's turn auto-starts
  //   P1 done        → host asks "P2 ready?"      → you say ready
  //   you say ready  → host calls start_p2_turn  → P2's turn auto-starts
  //   P2 done        → backend scores (lyrics+pitch) → host roasts + explains
  // startRef/advanceRef are placeholders until the handlers are defined below — this
  // decouples the host's onCommand from declaration order (handlers reference `voice`).
  const startRef = useRef<() => void>(() => {});
  const advanceRef = useRef<() => void>(() => {});
  const [pendingP2, setPendingP2] = useState(false);   // P1 done, awaiting host's start_p2_turn
  const pendingP2Ref = useRef(false);
  pendingP2Ref.current = pendingP2;

  // Who is singing RIGHT NOW, driven locally (not by the server's async currentTurn) so the
  // karaoke station + scoring fire at exactly the right moment — no race where scoring kicks
  // off during Player 2's turn.
  const [singing, setSinging] = useState<null | "p1" | "p2">(null);
  const singingRef = useRef<null | "p1" | "p2">(null);
  singingRef.current = singing;

  // NOTHING about the result shows automatically. The winner + scores stay hidden until the
  // host calls the reveal_scores tool (as he reads them out) → then the scoreboard loads in.
  const [scoresShown, setScoresShown] = useState(false);
  const scoresShownRef = useRef(false);
  scoresShownRef.current = scoresShown;
  const finishRef = useRef<FinishResponse | null>(null);
  finishRef.current = finish;
  const revealNowRef = useRef<() => void>(() => {});       // load scores + confetti + victory
  const revealDriverRef = useRef<(t: string) => void>(() => {});  // drives 3-2-1 off his captions

  // A start_*_turn tool call doesn't start the turn immediately — it would talk over the
  // music. We stash which turn to start, then launch a 3-2-1 countdown only AFTER the host
  // stops talking (onTurnComplete + audio drained), and the music starts when it hits 0.
  const pendingStartRef = useRef<null | "p1" | "p2">(null);
  const fallbackTimerRef = useRef<any>(null);            // ensures the round starts if turn_complete is odd
  const [countdown, setCountdown] = useState<number | null>(null);
  const [revealCountdown, setRevealCountdown] = useState<number | null>(null);   // "THE WINNER IS… 3-2-1"
  const [confetti, setConfetti] = useState(false);   // 🎉 burst on the winner reveal

  // Pre-grading + "keep talking while scoring" state.
  const gradeRef = useRef<{ p1?: Promise<any> }>({});   // P1's grade, computed during P2's turn
  const scoringRef = useRef(false);                      // backend is still tallying the result
  const fillerRef = useRef(0);                           // which stall prompt we're on
  const tellFillerRef = useRef<() => void>(() => {});

  const voice = useVoiceHost({
    onHostCaption: (t) => revealDriverRef.current(t),   // reveal scores off his spoken count
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
      // 2) Scores still loading → keep him talking with the next stall prompt (suppress mic),
      //    so the scoring screen never goes silent until the result lands.
      if (scoringRef.current) { tellFillerRef.current(); return true; }
      // 3) Result is on screen (host already revealed it) → stay quiet, don't reopen the mic.
      if (scoresShownRef.current) return true;
      return false;   // otherwise open the mic for your reply
    },
  });

  const handleCreateRoom = useCallback(() => {
    if (!wallet.publicKey) return;
    createRoom(wallet.publicKey.toBase58(), Math.floor(parseFloat(stakeSOL) * LAMPORTS_PER_SOL), "karaoke");
  }, [wallet.publicKey, stakeSOL, createRoom]);

  // "Start Game" button — pressed once BOTH players have joined. This user gesture brings
  // the host in (unlocks audio); the backend auto-greets and asks if we're ready to start.
  const handleEnterHost = useCallback(() => {
    voice.connect(true);
    // Warm the scoring music bed now (first generation takes a few seconds) so it's cached
    // and ready the instant we reach the scoring screen.
    fetch(`${API_BASE}/api/sfx/scoring_music`).catch(() => {});
    fetch(`${API_BASE}/api/sfx/victory`).catch(() => {});   // pre-warm the victory fanfare
  }, [voice]);

  // Host called start_p1_turn (after hearing "ready") → begin the match and put P1 on stage.
  // Staking is best-effort so the game always begins — never blocks on a wallet.
  const startP1 = useCallback(async () => {
    if (!room || singingRef.current) return;
    if (room.players.length >= 2) {
      try { await createAndStake(room.code, room.players[1].wallet, room.stake); }
      catch (e: any) { addLog("stake skipped: " + e.message); }
    }
    if (phase === "waiting") beginGame(room.code);   // server: game:started + turn P1
    setSinging("p1");                                 // local: render P1's station now
  }, [room, phase, createAndStake, beginGame, addLog]);
  startRef.current = startP1;

  // Host called start_p2_turn (after Player 2 says ready) → put P2 on stage. P1's score was
  // already submitted when P1 finished, so the server is already in p2_singing.
  const advanceToP2 = useCallback(() => {
    setPendingP2(false);
    setSinging("p2");
  }, []);
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
    if (/\bone\b|(^|\D)1(\D|$)/.test(s)) { setRevealCountdown(1); setTimeout(() => revealNowRef.current(), 550); }
    else if (/\btwo\b|(^|\D)2(\D|$)/.test(s)) setRevealCountdown(2);
    else if (/\bthree\b|(^|\D)3(\D|$)/.test(s)) setRevealCountdown(3);
  };

  // Grade ONE take on the backend (80% lyrics + 20% pitch). Used to score Player 1 in the
  // background the instant they finish — while Player 2 is still singing.
  const gradeTake = useCallback(async (take: Blob, player: "p1" | "p2") => {
    try {
      const fd = new FormData();
      fd.append("song_id", SONG_ID);
      fd.append("player", player);
      fd.append("take", take, `${player}.webm`);
      const r = await fetch(`${API_BASE}/api/match/grade`, { method: "POST", body: fd });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch {
      addLog(`pre-grade ${player} failed — will score at finish`);
      return null;
    }
  }, [addLog]);

  const tellFiller = useCallback(() => {
    voice.tell(FILLERS[fillerRef.current % FILLERS.length]);
    fillerRef.current += 1;
  }, [voice]);
  tellFillerRef.current = tellFiller;

  // Both takes recorded → finish. P1 was already graded during P2's turn, so we only wait
  // on P2 here. The host keeps talking (filler turns) until the result lands.
  const finishMatch = useCallback(async () => {
    const { p1, p2 } = takesRef.current;
    if (!room || !p1 || !p2) return;
    setScoring(true);
    scoringRef.current = true;
    fillerRef.current = 0;
    setScoresShown(false);   // keep numbers hidden until the host reads them
    addLog("Scoring (Player 1 pre-graded; tallying)…");
    void voice.startMusic("scoring_music", 0.1);   // low bed so there's never dead air
    tellFiller();   // kick off the stall; onTurnComplete keeps him going until scores load

    const p1Graded = gradeRef.current.p1 ? await gradeRef.current.p1 : null;
    const fd = new FormData();
    fd.append("match_id", room.matchId || room.code);
    fd.append("song_id", SONG_ID);
    fd.append("p1_pubkey", room.players[0]?.wallet || "p1");
    fd.append("p2_pubkey", room.players[1]?.wallet || "p2");
    fd.append("stake_lamports", String(room.stake ?? 0));
    if (p1Graded) fd.append("p1_graded", JSON.stringify(p1Graded));   // reuse the early grade
    else fd.append("take_p1", p1, "p1.webm");                          // fallback: grade at finish
    fd.append("take_p2", p2, "p2.webm");
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
        + `WINS and ONE line roasting the loser. The scoreboard pops up on its own when you say "One" — do NOT `
        + `read the numbers out.`
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
  }, [room, addLog, voice, tellFiller]);

  // A turn's song ended → its take is recorded. Driven by the LOCAL `singing` stage, not the
  // server's currentTurn, so there's no race. P1 holds for the "Player 2, ready?" gate; P2 scores.
  const handleTurnFinish = useCallback((result: KaraokeResult, take?: Blob) => {
    const who = singingRef.current;
    if (!who || !room) return;
    if (take) takesRef.current[who] = take;
    addLog(`${who.toUpperCase()} done`);
    setSinging(null);   // leave the station
    if (who === "p1") {
      if (take) gradeRef.current.p1 = gradeTake(take, "p1");          // score P1 NOW, while P2 sings
      submitScore(room.players[0].wallet, result.score);             // server: p1 → p2_singing
      setPendingP2(true);
      voice.tell("Player 1 just finished. In ONE short line, give Player 1 a light, GENERIC bit of "
        + "encouragement and challenge Player 2 — exactly like: \"Player 1, good start! Player 2, you "
        + "think you can beat that?\" The scores are NOT in yet, so keep it generic — do NOT claim a "
        + "specific score, that they nailed it, or 'set a high bar'. That line IS your cue to Player 2; "
        + "when Player 2 answers yes, call start_p2_turn.");
    } else {
      voice.startMusic("scoring_music", 0.1);   // start the bed NOW so there's no dead pause after singing
      submitScore(room.players[1].wallet, result.score);             // server: p2 → finished
      void finishMatch();
    }
  }, [room, addLog, submitScore, finishMatch, voice, gradeTake]);

  const joinUrl = room ? `${window.location.origin}/play?code=${room.code}` : null;
  const page: CSSProperties = { position: "relative", zIndex: 10, minHeight: "100vh", display: "flex", flexDirection: "column", background: PAL.purpleDp, fontFamily: FONT.body };
  const center: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, padding: "40px 20px", textAlign: "center" };

  // 3-2-1 countdown takes over the whole screen so the music never starts under the host's
  // voice — it begins only when this hits "GO". No blinking.
  if (countdown !== null) {
    return (
      <div style={page}>
        <OnAirBar home="/" tag="ON AIR" tagColor={PAL.red} blink={false} right="ROUND 1 · LIVE" />
        <StageBG>
          <div style={center}>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(14px,2.4vw,22px)", letterSpacing: 6, color: PAL.yellow, textShadow: `2px 2px 0 ${PAL.ink}` }}>GET READY TO SING</div>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(120px,30vw,300px)", lineHeight: 0.9, color: PAL.slime, WebkitTextStroke: `4px ${PAL.ink}`, textShadow: `8px 8px 0 ${PAL.ink}` }}>{countdown}</div>
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
        <OnAirBar home="/" tag="FINAL" tagColor={PAL.slime} blink={false} right="MIC DROP TV · THE VERDICT" />
        <StageBG>
          <div style={center}>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(18px,3.4vw,30px)", letterSpacing: 5, color: PAL.yellow, textShadow: `2px 2px 0 ${PAL.ink}` }}>THE WINNER IS…</div>
            <div style={{ fontFamily: FONT.display, fontSize: "clamp(120px,30vw,300px)", lineHeight: 0.9, color: PAL.magenta, WebkitTextStroke: `4px ${PAL.ink}`, textShadow: `8px 8px 0 ${PAL.ink}` }}>{revealCountdown}</div>
          </div>
        </StageBG>
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  // Someone is on stage: hand the whole screen to the live karaoke station (music auto-starts).
  // Keyed by `singing` so it cleanly remounts between P1 and P2.
  if (singing && room) {
    return (
      <>
        <Karaoke
          key={singing}
          playerLabel={`${singing === "p1" ? "Player 1" : "Player 2"} — sing into this laptop!`}
          autoPlay
          onFinish={handleTurnFinish}
        />
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </>
    );
  }

  // Between turns: P1 sang, host is asking if Player 2 is ready. Hold here until the host
  // calls start_p2_turn (advanceToP2) — don't show the station yet.
  if (pendingP2 && room) {
    return (
      <div style={page}>
        <OnAirBar home="/" tag="UP NEXT" tagColor={PAL.yellow} blink={false} right="MIC DROP TV · CHANGEOVER" />
        <StageBG>
          <div style={center}>
            <Nameplate kicker="UP NEXT" name="PLAYER 2" color={PAL.magenta} />
            <div style={{ fontFamily: FONT.body, fontWeight: 800, fontSize: 22, color: PAL.white, maxWidth: 520 }}>
              Tell the host when you're ready — your song starts on the count.
            </div>
          </div>
        </StageBG>
        <LowerThird
          kicker={voice.listening ? "LISTENING 🔊" : "ON DECK"}
          kickerColor={voice.listening ? PAL.slime : PAL.yellow} kickerFg={PAL.ink}
          headline={voice.listening ? "Say “I'm ready!” and Player 2 is up." : "The MC is talking — get set, Player 2."}
          bodyColor={PAL.white} />
        <Captions host={voice.hostCaption} you={voice.youCaption} />
      </div>
    );
  }

  const bar = phase === "lobby" || phase === "waiting"
    ? { tag: "STANDBY", color: PAL.cyan, right: "MIC DROP TV · GREEN ROOM" }
    : scoring && !finish
      ? { tag: "REPLAY", color: PAL.yellow, right: "MIC DROP TV · JUDGES' ROOM" }
      : { tag: "FINAL", color: PAL.slime, right: "MIC DROP TV · THE VERDICT" };

  return (
    <div style={page}>
      <OnAirBar home="/" tag={bar.tag} tagColor={bar.color} blink={false} right={bar.right}
        left={<div style={{ marginLeft: 8 }}><WalletMultiButton /></div>} />
      <StageBG>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: "32px 18px", width: "100%", maxWidth: 860, margin: "0 auto" }}>

          {phase === "lobby" && (
            <>
              <div style={kicker(PAL.yellow)}>TONIGHT'S MATCHUP</div>
              <Panel color={PAL.white} title="SET THE BILL" titleBg={PAL.purple} titleFg={PAL.white} style={{ width: "100%", maxWidth: 420 }}>
                <label style={{ fontFamily: FONT.display, fontSize: 14, letterSpacing: 1, color: PAL.ink }}>WAGER (SOL)</label>
                <input type="number" step="0.001" min="0.001" value={stakeSOL} onChange={(e) => setStakeSOL(e.target.value)}
                  style={{ width: "100%", marginTop: 6, background: PAL.cream, border: `3px solid ${PAL.ink}`, borderRadius: 0, fontFamily: FONT.mono, fontSize: 20, padding: "10px 12px", color: PAL.ink }} />
              </Panel>
            </>
          )}

          {phase === "waiting" && room && (
            <>
              <div style={kicker(PAL.yellow)}>CALL IN TO COMPETE</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                <Panel color={PAL.white} title="ROOM CODE" titleBg={PAL.purple} titleFg={PAL.white} bodyStyle={{ textAlign: "center" }}>
                  <div style={{ fontFamily: FONT.display, fontSize: "clamp(48px,12vw,84px)", letterSpacing: 8, color: PAL.ink, lineHeight: 0.95 }}>{room.code}</div>
                  <div style={{ fontFamily: FONT.mono, fontSize: 16, color: PAL.purpleDp }}>micdrop · /play</div>
                </Panel>
                {joinUrl && (
                  <Panel color={PAL.white} title="OR SCAN" titleBg={PAL.cyanDk} titleFg={PAL.white}>
                    <div style={{ background: "#fff", padding: 8, border: `3px solid ${PAL.ink}` }}><QRCode value={joinUrl} size={150} /></div>
                  </Panel>
                )}
              </div>
              <Panel color={PAL.white} title={`ROSTER · ${room.players.length} / 2 CHECKED IN`} titleBg={PAL.ink} titleFg={PAL.slime} style={{ width: "100%", maxWidth: 480 }}>
                {room.players.map((p) => (
                  <div key={p.wallet} style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.slimeDk, borderBottom: `2px solid ${PAL.ink}22`, padding: "5px 0" }}>
                    <span style={{ color: PAL.slimeDk }}>✓</span> {p.name} — {p.wallet.slice(0, 8)}…
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
                Both takes are in — the MC's deliberating while the judges count every frame.
              </div>
              <div style={{ width: "100%", maxWidth: 560, height: 18, border: `3px solid ${PAL.ink}`, background: PAL.white, overflow: "hidden" }}>
                <div style={{ height: "100%", width: "70%", background: `repeating-linear-gradient(45deg, ${PAL.orange} 0 12px, ${PAL.yellow} 12px 24px)` }} />
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 15, color: PAL.cyan }}>lyrics ×0.8 + pitch ×0.2 — the MC's keeping the crowd warm…</div>
            </>
          )}

          {phase === "finished" && room && finish && (
            !scoresShown ? (
              <div style={{ fontFamily: FONT.display, fontSize: "clamp(22px,5vw,40px)", letterSpacing: 2, color: PAL.white, textShadow: `3px 3px 0 ${PAL.ink}`, textAlign: "center" }}>🔊 THE MC IS REVEALING THE RESULTS…</div>
            ) : (
              <>
                <div style={kicker(PAL.yellow)}>YOUR WINNER</div>
                <div style={{ fontFamily: FONT.display, fontSize: "clamp(40px,9vw,92px)", color: PAL.white, WebkitTextStroke: `2px ${PAL.ink}`, textShadow: `5px 5px 0 ${PAL.ink}`, transform: "rotate(-1deg)", lineHeight: 0.95 }}>
                  {finish.winner === "tie" ? "IT'S A TIE" : (finish.winner === "p1" ? room.players[0]?.name : room.players[1]?.name)?.toUpperCase()}
                </div>
                <ScoreBug big
                  a={{ name: room.players[0]?.name ?? "P1", score: finish.scores[0]?.score ?? 0, color: finish.winner === "p1" ? PAL.slime : PAL.white }}
                  b={{ name: room.players[1]?.name ?? "P2", score: finish.scores[1]?.score ?? 0, color: finish.winner === "p2" ? PAL.slime : PAL.magenta, fg: finish.winner === "p2" ? PAL.ink : PAL.white }} />
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", width: "100%", maxWidth: 640 }}>
                  {room.players.map((p, i) => {
                    const s = finish.scores[i];
                    const win = finish.winner === (i === 0 ? "p1" : "p2");
                    return (
                      <Panel key={p.wallet} color={PAL.white} titleBg={PAL.ink} titleFg={win ? PAL.slime : PAL.white}
                        title={<span>{win ? "🏆 " : ""}{p.name} — {s?.score ?? "—"}/100</span>} style={{ flex: "1 1 250px" }}>
                        <div style={{ fontFamily: FONT.mono, fontSize: 14, color: PAL.ink }}>📝 lyrics {s?.lyrics_score ?? "—"} (×0.8) &nbsp; 🎵 pitch {s?.pitch_score ?? "—"} (×0.2)</div>
                        {s?.transcript && <div style={{ fontFamily: FONT.mono, fontSize: 12, fontStyle: "italic", color: PAL.purpleDp, marginTop: 4, wordBreak: "break-word" }}>heard: “{s.transcript}”</div>}
                      </Panel>
                    );
                  })}
                </div>
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
            <Panel color={PAL.ink} title="DIRECTOR'S LOG" titleBg={PAL.purple} titleFg={PAL.white} shadow={4} style={{ width: "100%", maxWidth: 560 }} bodyStyle={{ maxHeight: 110, overflowY: "auto" }}>
              {log.length === 0
                ? <div style={{ fontFamily: FONT.mono, fontSize: 13, color: `${PAL.slime}88` }}>events will appear here</div>
                : log.map((l, i) => <div key={i} style={{ fontFamily: FONT.mono, fontSize: 13, color: PAL.slime }}>{l}</div>)}
            </Panel>
          )}
        </div>
      </StageBG>

      {phase === "lobby" && (
        <LowerThird kicker="UP NEXT" kickerColor={PAL.yellow} kickerFg={PAL.ink}
          headline="Lock the wager — then put it on air." bodyColor={PAL.slime}
          action={<BevelBtn color={PAL.slime} onClick={handleCreateRoom} disabled={busy || !wallet.publicKey}>{wallet.publicKey ? "GO LIVE »" : "CONNECT WALLET"}</BevelBtn>} />
      )}
      {phase === "waiting" && (
        <LowerThird
          kicker={voice.connected ? (voice.listening ? "LISTENING 🔊" : "ON AIR") : "WAITING"}
          kickerColor={voice.connected ? PAL.slime : PAL.orange} kickerFg={PAL.ink}
          headline={!voice.connected
            ? "Challenger checks in, then go live — the MC's got material."
            : voice.listening ? "Say “I'm ready!” to kick it off." : "The AI host is hyping up the room…"}
          bodyColor={PAL.white}
          action={!voice.connected ? <BevelBtn color={PAL.slime} onClick={handleEnterHost} disabled={!room || room.players.length < 2}>{room && room.players.length < 2 ? "WAITING…" : "START »"}</BevelBtn> : undefined} />
      )}
      {phase === "finished" && (
        <LowerThird kicker="THE MC 🔊" kickerColor={PAL.magenta} kickerFg={PAL.white}
          headline={finish && scoresShown ? "That's the show. Run it back?" : "Reviewing every frame. Counting the SOL. Sharpening the burns."}
          bodyColor={PAL.white}
          action={<BevelBtn color={PAL.orange} onClick={() => window.location.reload()}>REMATCH »</BevelBtn>} />
      )}

      {confetti && <Confetti />}
      <Captions host={voice.hostCaption} you={voice.youCaption} />
    </div>
  );
}
