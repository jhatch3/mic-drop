import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import Player from "./game/Player";
import KaraokeHost from "./game/KaraokeHost";
import DanceHost from "./dance/DanceHost";
import Home from "./pages/Home";
import CreateLobby from "./pages/CreateLobby";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

function Router() {
  const path = window.location.pathname;
  if (path === "/host") return <KaraokeHost />;
  if (path === "/play") return <Player />;
  if (path === "/dance-host") return <DanceHost />;
  if (path === "/create") return <CreateLobby />;
  if (path === "/test") return <App />;
  return <Home />;
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
