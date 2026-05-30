import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import type { PitchBattle } from "../target/types/pitch_battle";

describe("pitch-battle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PitchBattle as Program<PitchBattle>;

  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const oracle = Keypair.generate();
  const rando = Keypair.generate(); // non-oracle, used for rejection test
  const matchId = "test-" + Date.now().toString().slice(-8);
  const STAKE = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL each

  let matchPda: PublicKey;
  let vaultPda: PublicKey;

  const airdrop = async (kp: Keypair, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
  };

  before(async () => {
    await Promise.all([p1, p2, oracle, rando].map((k) => airdrop(k)));

    [matchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("match"), Buffer.from(matchId)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(matchId)],
      program.programId
    );
  });

  it("create_match: initialises Match account correctly", async () => {
    await program.methods
      .createMatch(matchId, STAKE, p2.publicKey, oracle.publicKey)
      .accounts({
        playerOne: p1.publicKey,
        matchAccount: matchPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([p1])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    assert.equal(m.matchId, matchId);
    assert.equal(m.playerOne.toBase58(), p1.publicKey.toBase58());
    assert.equal(m.playerTwo.toBase58(), p2.publicKey.toBase58());
    assert.equal(m.oracle.toBase58(), oracle.publicKey.toBase58());
    assert.isTrue(m.stakeLamports.eq(STAKE));
    assert.isFalse(m.p1Staked);
    assert.isFalse(m.p2Staked);
    assert.deepEqual(m.state, { open: {} });
    assert.isNull(m.winner);
  });

  it("stake: p1 stakes, state stays Open", async () => {
    await program.methods
      .stake(matchId)
      .accounts({
        signer: p1.publicKey,
        matchAccount: matchPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([p1])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    assert.isTrue(m.p1Staked);
    assert.isFalse(m.p2Staked);
    assert.deepEqual(m.state, { open: {} });
  });

  it("stake: p2 stakes, vault holds 2×stake, state = Staked", async () => {
    await program.methods
      .stake(matchId)
      .accounts({
        signer: p2.publicKey,
        matchAccount: matchPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([p2])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    assert.isTrue(m.p1Staked);
    assert.isTrue(m.p2Staked);
    assert.deepEqual(m.state, { staked: {} });

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    assert.equal(vaultBalance, STAKE.toNumber() * 2, "vault should hold 2×stake");
  });

  it("stake: double-stake by p1 is rejected", async () => {
    try {
      await program.methods
        .stake(matchId)
        .accounts({
          signer: p1.publicKey,
          matchAccount: matchPda,
          vault: vaultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([p1])
        .rpc();
      assert.fail("Expected AlreadyStaked error");
    } catch (e: any) {
      assert.include(e.message, "AlreadyStaked");
    }
  });

  it("settle: non-oracle signer is rejected", async () => {
    try {
      await program.methods
        .settle(matchId, p1.publicKey)
        .accounts({
          oracle: rando.publicKey,
          matchAccount: matchPda,
          vault: vaultPda,
          winnerAccount: p1.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rando])
        .rpc();
      assert.fail("Expected oracle constraint error");
    } catch (e: any) {
      // Anchor throws a ConstraintHasOne or custom error
      assert.ok(e.message, "should throw");
    }
  });

  it("settle: oracle settles, winner receives 2×stake, vault emptied", async () => {
    const p1BalanceBefore = await provider.connection.getBalance(p1.publicKey);

    await program.methods
      .settle(matchId, p1.publicKey)
      .accounts({
        oracle: oracle.publicKey,
        matchAccount: matchPda,
        vault: vaultPda,
        winnerAccount: p1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    assert.deepEqual(m.state, { settled: {} });
    assert.equal(m.winner?.toBase58(), p1.publicKey.toBase58());

    const p1BalanceAfter = await provider.connection.getBalance(p1.publicKey);
    assert.approximately(
      p1BalanceAfter - p1BalanceBefore,
      STAKE.toNumber() * 2,
      10_000 // tolerance for tx fees
    );

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    assert.equal(vaultBalance, 0);
  });
});

// ─── Refund test (separate match) ────────────────────────────────────────────

describe("pitch-battle — refund", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.PitchBattle as Program<PitchBattle>;

  const p1 = Keypair.generate();
  const p2 = Keypair.generate();
  const oracle = Keypair.generate();
  const matchId = "refund-" + Date.now().toString().slice(-8);
  const STAKE = new BN(0.1 * LAMPORTS_PER_SOL);

  let matchPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    for (const kp of [p1, p2, oracle]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
    [matchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("match"), Buffer.from(matchId)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(matchId)],
      program.programId
    );

    // create + both stake
    await program.methods
      .createMatch(matchId, STAKE, p2.publicKey, oracle.publicKey)
      .accounts({ playerOne: p1.publicKey, matchAccount: matchPda, vault: vaultPda, systemProgram: anchor.web3.SystemProgram.programId })
      .signers([p1]).rpc();
    for (const [kp] of [[p1], [p2]] as [Keypair][]) {
      await program.methods
        .stake(matchId)
        .accounts({ signer: kp.publicKey, matchAccount: matchPda, vault: vaultPda, systemProgram: anchor.web3.SystemProgram.programId })
        .signers([kp]).rpc();
    }
  });

  it("refund: oracle refunds both players, vault emptied", async () => {
    const p1Before = await provider.connection.getBalance(p1.publicKey);
    const p2Before = await provider.connection.getBalance(p2.publicKey);

    await program.methods
      .refund(matchId)
      .accounts({
        oracle: oracle.publicKey,
        matchAccount: matchPda,
        vault: vaultPda,
        playerOneAccount: p1.publicKey,
        playerTwoAccount: p2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const m = await program.account.match.fetch(matchPda);
    assert.deepEqual(m.state, { settled: {} });

    const p1After = await provider.connection.getBalance(p1.publicKey);
    const p2After = await provider.connection.getBalance(p2.publicKey);
    assert.approximately(p1After - p1Before, STAKE.toNumber(), 10_000);
    assert.approximately(p2After - p2Before, STAKE.toNumber(), 10_000);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    assert.equal(vaultBalance, 0);
  });
});
