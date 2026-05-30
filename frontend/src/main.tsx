import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import Host from "./game/Host";
import Player from "./game/Player";
import DanceStation from "./dance/DanceStation";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

function Router() {
  const path = window.location.pathname;
  if (path === "/host") return <Host />;
  if (path === "/play") return <Player />;
  if (path === "/dance-host") return <DanceStation />;
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
