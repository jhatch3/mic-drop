import { useState, useEffect, useCallback } from "react";
import { getSocket } from "../game/socket";
import type { RoomState } from "../game/types";

type Phase = "lobby" | "waiting" | "gaming" | "finished";

export function useGameRoom() {
  const socket = getSocket();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [currentTurn, setCurrentTurn] = useState<{ player: string; wallet: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    setLog((p) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p]);
  }, []);

  useEffect(() => {
    socket.on("room:created", (r: RoomState) => {
      setRoom(r);
      setPhase("waiting");
      addLog(`Room ${r.code} created. Waiting for P2…`);
    });
    socket.on("room:updated", (r: RoomState) => {
      setRoom(r);
      if (r.players.length === 2) addLog(`${r.players[1].wallet.slice(0, 6)}… joined as P2`);
    });
    socket.on("game:started", (r: RoomState) => {
      setRoom(r);
      setPhase("gaming");
      addLog("Game started!");
    });
    socket.on("turn:start", (t: { player: string; wallet: string }) => {
      setCurrentTurn(t);
      addLog(`${t.player}'s turn`);
    });
    socket.on("game:over", (r: RoomState) => {
      setRoom(r);
      setPhase("finished");
      const winner = r.players.find((p) => p.wallet === r.winner);
      addLog(r.winner ? `${winner?.name ?? "?"} wins!` : "Tie!");
    });
    socket.on("error", ({ msg }: { msg: string }) => addLog(`Error: ${msg}`));
    return () => { socket.removeAllListeners(); };
  }, [socket, addLog]);

  const createRoom = useCallback((walletAddress: string, stakeLamports: number, gamemode?: string) => {
    socket.emit("room:create", { wallet: walletAddress, stake: stakeLamports, ...(gamemode && { gamemode }) });
  }, [socket]);

  const beginGame = useCallback((roomCode: string) => {
    socket.emit("match:set_id", { code: roomCode, matchId: roomCode });
    socket.emit("game:start", { code: roomCode });
  }, [socket]);

  const submitScore = useCallback((walletAddress: string, score: number) => {
    setRoom((r) => {
      if (r) socket.emit("score:submit", { code: r.code, wallet: walletAddress, score });
      return r;
    });
  }, [socket]);

  return { room, phase, currentTurn, log, addLog, createRoom, beginGame, submitScore };
}
