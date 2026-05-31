import "./index.css";
import "./ui/fonts.css";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import Player from "./game/Player";
import Karaoke from "./game/Karaoke";
import { RetroBackground, Scanlines } from "./retro";
import LocalGame from "./game/LocalGame";
import KaraokeHost from "./game/KaraokeHost";
import DanceHost from "./dance/DanceHost";
import Home from "./pages/Home";
import Landing from "./pages/Landing";
import DanceLanding from "./pages/DanceLanding";
import Leaderboard from "./pages/Leaderboard";
import CreateLobby from "./pages/CreateLobby";

// Resolve the RPC endpoint with a clear, RUNTIME-overridable precedence so a
// stale build (or a deploy missing VITE_RPC_URL) can't silently strand us on the
// rate-limited public endpoint:
//   1. ?rpc=<url> query param   (quickest override, no rebuild)
//   2. localStorage "pb_rpc_url" (sticky override)
//   3. VITE_RPC_URL              (baked at build time)
//   4. public devnet            (LAST resort — rate-limits with 429s)
const PUBLIC_DEVNET = "https://api.devnet.solana.com";
function resolveRpc(): string {
  try {
    const qp = new URLSearchParams(window.location.search).get("rpc");
    if (qp) { localStorage.setItem("pb_rpc_url", qp); return qp; }
    const ls = localStorage.getItem("pb_rpc_url");
    if (ls) return ls;
  } catch { /* ignore */ }
  const env = import.meta.env.VITE_RPC_URL;
  if (env) return env;
  return PUBLIC_DEVNET;
}
const RPC = resolveRpc();
// Loud, always-on banner so the active endpoint is never a mystery again.
const onPublic = RPC === PUBLIC_DEVNET;
// eslint-disable-next-line no-console
console.info(
  `%c[Pitch Battle] RPC endpoint = ${RPC}`,
  `color:${onPublic ? "#f87171" : "#4ade80"};font-weight:bold`,
);
if (onPublic) {
  // eslint-disable-next-line no-console
  console.warn(
    "[Pitch Battle] Using the PUBLIC devnet RPC — it rate-limits with 429s. " +
    "Set VITE_RPC_URL (then REBUILD/restart vite) or append ?rpc=<your-rpc-url> to the URL.",
  );
}

function Router() {
  const path = window.location.pathname;
  if (path === "/host") return <KaraokeHost />;
  if (path === "/play") return <Player />;
  if (path === "/karaoke") return <Karaoke />;
  if (path === "/local") return <LocalGame />;
  if (path === "/dance") return <DanceLanding />;
  if (path === "/dance-host") return <DanceHost />;
  if (path === "/create") return <CreateLobby />;
  if (path === "/test") return <App />;
  if (path === "/leaderboard") return <Leaderboard mode="karaoke" />;
  if (path === "/dance-leaderboard") return <Leaderboard mode="dance" />;
  if (path === "/home") return <Home />;   // old retro landing (kept for reference)
  return <Landing />;
}

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <RetroBackground />
          <Router />
          <Scanlines />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
