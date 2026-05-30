const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const {
  createRoom, joinRoom, getRoom, getRoomBySocket,
  setMatchId, startGame, submitScore, deleteRoom,
} = require("./rooms");

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/api/rooms/:code", (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: "Not found" });
  res.json(publicRoom(room));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function publicRoom(room) {
  return {
    code: room.code,
    stake: room.stake,
    state: room.state,
    matchId: room.matchId,
    winner: room.winner,
    players: room.players.map((p) => ({
      name: p.name,
      wallet: p.wallet,
      score: p.score,
    })),
  };
}

function broadcast(code, event, data) {
  io.to(code).emit(event, data);
}

// ─── Sockets ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connect", socket.id);

  // ── room:create ─────────────────────────────────────────────────────────
  // payload: { wallet: string, stake: number (lamports) }
  socket.on("room:create", ({ wallet, stake } = {}) => {
    if (!wallet || !stake) return socket.emit("error", { msg: "wallet and stake required" });
    const room = createRoom({ hostWallet: wallet, stake, hostSocketId: socket.id });
    socket.join(room.code);
    socket.emit("room:created", publicRoom(room));
    console.log(`Room ${room.code} created by ${wallet.slice(0, 6)}…`);
  });

  // ── room:join ────────────────────────────────────────────────────────────
  // payload: { code: string, wallet: string }
  socket.on("room:join", ({ code, wallet } = {}) => {
    if (!code || !wallet) return socket.emit("error", { msg: "code and wallet required" });
    const result = joinRoom(code, { wallet, socketId: socket.id });
    if (result.error) return socket.emit("error", { msg: result.error });
    socket.join(result.room.code);
    broadcast(result.room.code, "room:updated", publicRoom(result.room));
    console.log(`${wallet.slice(0, 6)}… joined room ${result.room.code}`);
  });

  // ── match:set_id ─────────────────────────────────────────────────────────
  // Host sends this after creating the Solana escrow match
  // payload: { code: string, matchId: string }
  socket.on("match:set_id", ({ code, matchId } = {}) => {
    setMatchId(code?.toUpperCase(), matchId);
    broadcast(code?.toUpperCase(), "room:updated", publicRoom(getRoom(code)));
  });

  // ── game:start ───────────────────────────────────────────────────────────
  // payload: { code: string }
  socket.on("game:start", ({ code } = {}) => {
    const result = startGame(code?.toUpperCase());
    if (result.error) return socket.emit("error", { msg: result.error });
    broadcast(result.room.code, "game:started", publicRoom(result.room));
    broadcast(result.room.code, "turn:start", { player: "P1", wallet: result.room.players[0].wallet });
    console.log(`Game started in room ${result.room.code}`);
  });

  // ── score:submit ─────────────────────────────────────────────────────────
  // payload: { code: string, wallet: string, score: number (0-100) }
  socket.on("score:submit", ({ code, wallet, score } = {}) => {
    const result = submitScore(code?.toUpperCase(), wallet, score);
    if (result.error) return socket.emit("error", { msg: result.error });
    broadcast(result.room.code, "room:updated", publicRoom(result.room));
    if (result.next === "p2") {
      broadcast(result.room.code, "turn:start", { player: "P2", wallet: result.room.players[1].wallet });
    } else if (result.next === "finished") {
      broadcast(result.room.code, "game:over", publicRoom(result.room));
    }
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    // Only notify, don't delete — let players reconnect within a grace period
    broadcast(room.code, "player:disconnected", { socketId: socket.id });
    console.log(`Socket ${socket.id} disconnected from room ${room.code}`);
  });
});

server.listen(PORT, () => {
  console.log(`Pitch Battle server running on :${PORT}`);
});
