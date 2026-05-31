import { io, Socket } from "socket.io-client";

// Default to SAME ORIGIN ("") so socket.io connects to wherever the page is served
// (localhost or the cloudflare tunnel) and Vite proxies /socket.io → the session
// server. Override with VITE_SERVER_URL if you need a direct connection.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // websocket + polling fallback so it works through proxies/tunnels.
    socket = io(SERVER_URL, { transports: ["websocket", "polling"] });
  }
  return socket;
}
