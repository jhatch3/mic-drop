// In-memory room store
const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeCode() : code; // retry on collision
}

function createRoom({ hostWallet, stake, hostSocketId }) {
  const code = makeCode();
  const room = {
    code,
    hostSocketId,
    hostWallet,
    stake,          // lamports
    players: [
      { wallet: hostWallet, socketId: hostSocketId, name: "P1", score: null, staked: false },
    ],
    state: "waiting", // waiting | staking | p1_singing | p2_singing | finished
    matchId: null,
    winner: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(code, { wallet, socketId }) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: "Room not found" };
  if (room.state !== "waiting") return { error: "Game already started" };
  if (room.players.length >= 2) return { error: "Room is full" };
  if (room.players[0].wallet === wallet) return { error: "Already in room" };

  room.players.push({ wallet, socketId, name: "P2", score: null, staked: false });
  return { room };
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase()) ?? null;
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

function setMatchId(code, matchId) {
  const room = rooms.get(code);
  if (room) room.matchId = matchId;
}

function startGame(code) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" };
  if (room.players.length < 2) return { error: "Need 2 players" };
  if (room.state !== "waiting") return { error: "Already started" };
  room.state = "p1_singing";
  return { room };
}

function submitScore(code, wallet, score) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" };
  const player = room.players.find((p) => p.wallet === wallet);
  if (!player) return { error: "Not in room" };
  player.score = score;

  if (room.state === "p1_singing" && wallet === room.players[0].wallet) {
    room.state = "p2_singing";
    return { room, next: "p2" };
  }
  if (room.state === "p2_singing" && wallet === room.players[1].wallet) {
    const [p1, p2] = room.players;
    room.winner =
      p1.score > p2.score ? p1.wallet :
      p2.score > p1.score ? p2.wallet :
      null; // tie
    room.state = "finished";
    return { room, next: "finished" };
  }
  return { error: "Not your turn" };
}

// Mark a player as having staked on-chain. Returns { room, bothStaked }
function markStaked(code, wallet) {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" };
  const player = room.players.find(p => p.wallet === wallet);
  if (!player) return { error: "Not in room" };
  player.staked = true;
  const bothStaked = room.players.length === 2 && room.players.every(p => p.staked);
  if (bothStaked) room.state = "staking_complete";
  return { room, bothStaked };
}

function deleteRoom(code) {
  rooms.delete(code);
}

module.exports = { createRoom, joinRoom, getRoom, getRoomBySocket, setMatchId, startGame, submitScore, markStaked, deleteRoom };
