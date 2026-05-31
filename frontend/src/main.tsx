import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import Host from "./game/Host";
import Player from "./game/Player";

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
  if (path === "/host") return <Host />;
  if (path === "/play") return <Player />;
  return <App />;
}

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Router />
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
