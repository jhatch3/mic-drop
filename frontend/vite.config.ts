import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Single-origin routing so ONE tunnel (cloudflared → :5173) serves the whole app:
// the phone hits the tunnel URL and everything is proxied from here.
const BACKEND = "http://localhost:8000";   // FastAPI
const SESSION = "http://localhost:3001";   // Socket.io session server

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({ include: ["buffer", "crypto", "stream", "util"] }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: true,                 // bind 0.0.0.0 so the tunnel/LAN can reach it
    allowedHosts: true,         // accept the cloudflare tunnel hostname
    proxy: {
      "/socket.io": { target: SESSION, ws: true, changeOrigin: true },  // game session WS
      "/api":       { target: BACKEND, changeOrigin: true },            // scoring/oracle/songs
      "/ws":        { target: BACKEND, ws: true, changeOrigin: true },  // voice host + live
      "/sfx-audio": { target: BACKEND, changeOrigin: true },
      "/mc-audio":  { target: BACKEND, changeOrigin: true },
    },
  },
  define: { global: "globalThis" },
});
