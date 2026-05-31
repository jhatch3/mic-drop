import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { NeonHeading, NeonButton, CRTCard } from "@/retro";

const go = (path: string) => () => { window.location.href = path; };

export default function Home() {
  return (
    <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-5 py-10 text-foreground">
      <div className="absolute right-5 top-5"><WalletMultiButton /></div>

      <div className="w-full max-w-xl text-center">
        <NeonHeading className="text-2xl sm:text-3xl leading-relaxed">PITCH&nbsp;BATTLE</NeonHeading>
        <p className="mt-4 font-body text-lg text-muted-foreground">
          Stake your cash. Sing your heart out. <span className="text-cyan">Winner takes the pot.</span>
        </p>

        <NeonButton onClick={go("/host")} size="lg" className="mt-7">🎤 Host a Game →</NeonButton>

        <div className="mt-9 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button onClick={go("/create")} className="text-left">
            <CRTCard glow="purple" animate={false} className="h-full transition-transform hover:-translate-y-0.5">
              <div className="text-3xl">🎮</div>
              <div className="font-display mt-2 text-sm text-foreground">Create Lobby</div>
              <div className="font-body text-sm text-muted-foreground">Pick a mode, set your wager</div>
            </CRTCard>
          </button>
          <button onClick={go("/play")} className="text-left">
            <CRTCard glow="cyan" animate={false} className="h-full transition-transform hover:-translate-y-0.5">
              <div className="text-3xl">📱</div>
              <div className="font-display mt-2 text-sm text-foreground">Join on Phone</div>
              <div className="font-body text-sm text-muted-foreground">Link your wallet & ready up</div>
            </CRTCard>
          </button>
        </div>

        <div className="font-display mt-10 text-[9px] uppercase tracking-widest text-muted-foreground/60">
          Powered by Solana devnet
        </div>
      </div>
    </div>
  );
}
