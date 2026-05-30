use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Placeholder — replace with the key from target/deploy/pitch_battle-keypair.json after `anchor build`
declare_id!("2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf");

#[program]
pub mod pitch_battle {
    use super::*;

    /// P1 creates the match and records the oracle, treasury, and fee.
    /// fee_bps is in basis points: 100 = 1%, 1 = 0.01%.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: String,
        stake_lamports: u64,
        player_two: Pubkey,
        oracle: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(match_id.len() <= 32, PitchError::MatchIdTooLong);
        require!(fee_bps <= 1_000, PitchError::FeeTooHigh); // max 10%
        let m = &mut ctx.accounts.match_account;
        m.match_id = match_id;
        m.player_one = ctx.accounts.player_one.key();
        m.player_two = player_two;
        m.oracle = oracle;
        m.treasury = treasury;
        m.fee_bps = fee_bps;
        m.stake_lamports = stake_lamports;
        m.p1_staked = false;
        m.p2_staked = false;
        m.state = MatchState::Open;
        m.winner = None;
        m.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// P1 or P2 transfers stake_lamports into the vault.
    /// When both have staked the match moves to Staked.
    pub fn stake(ctx: Context<Stake>, _match_id: String) -> Result<()> {
        let signer_key = ctx.accounts.signer.key();
        let is_p1 = signer_key == ctx.accounts.match_account.player_one;
        let is_p2 = signer_key == ctx.accounts.match_account.player_two;

        require!(is_p1 || is_p2, PitchError::NotAPlayer);
        require!(
            ctx.accounts.match_account.state != MatchState::Settled,
            PitchError::AlreadySettled
        );
        if is_p1 {
            require!(!ctx.accounts.match_account.p1_staked, PitchError::AlreadyStaked);
        }
        if is_p2 {
            require!(!ctx.accounts.match_account.p2_staked, PitchError::AlreadyStaked);
        }

        let amount = ctx.accounts.match_account.stake_lamports;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.signer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        if is_p1 {
            ctx.accounts.match_account.p1_staked = true;
        }
        if is_p2 {
            ctx.accounts.match_account.p2_staked = true;
        }
        if ctx.accounts.match_account.p1_staked && ctx.accounts.match_account.p2_staked {
            ctx.accounts.match_account.state = MatchState::Staked;
        }

        Ok(())
    }

    /// Oracle-only. Splits the pot: fee → treasury, remainder → winner.
    /// `has_one = oracle` and the treasury constraint are enforced in the accounts struct.
    pub fn settle(ctx: Context<Settle>, match_id: String, winner: Pubkey) -> Result<()> {
        let player_one = ctx.accounts.match_account.player_one;
        let player_two = ctx.accounts.match_account.player_two;
        let pot = ctx.accounts.match_account
            .stake_lamports
            .checked_mul(2)
            .ok_or(PitchError::Overflow)?;
        let fee_bps = ctx.accounts.match_account.fee_bps as u64;
        let vault_bump = ctx.accounts.match_account.vault_bump;

        require!(
            ctx.accounts.match_account.state == MatchState::Staked,
            PitchError::NotStaked
        );
        require!(
            winner == player_one || winner == player_two,
            PitchError::InvalidWinner
        );

        // fee = pot * fee_bps / 10_000  (rounds down, winner gets remainder)
        let fee = pot
            .checked_mul(fee_bps)
            .ok_or(PitchError::Overflow)?
            .checked_div(10_000)
            .unwrap_or(0);
        let winner_amount = pot.checked_sub(fee).ok_or(PitchError::Overflow)?;

        ctx.accounts.match_account.winner = Some(winner);
        ctx.accounts.match_account.state = MatchState::Settled;

        let seeds: &[&[u8]] = &[b"vault", match_id.as_bytes(), &[vault_bump]];

        // Pay winner
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_account.to_account_info(),
                },
                &[seeds],
            ),
            winner_amount,
        )?;

        // Pay treasury fee (skip if fee is 0)
        if fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        Ok(())
    }

    /// Oracle-only. Tie case — returns each player's stake.
    pub fn refund(ctx: Context<Refund>, match_id: String) -> Result<()> {
        let stake = ctx.accounts.match_account.stake_lamports;
        let vault_bump = ctx.accounts.match_account.vault_bump;

        require!(
            ctx.accounts.match_account.state == MatchState::Staked,
            PitchError::NotStaked
        );

        ctx.accounts.match_account.state = MatchState::Settled;

        let seeds: &[&[u8]] = &[b"vault", match_id.as_bytes(), &[vault_bump]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_one_account.to_account_info(),
                },
                &[seeds],
            ),
            stake,
        )?;

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_two_account.to_account_info(),
                },
                &[seeds],
            ),
            stake,
        )?;

        Ok(())
    }
}

// ─── State ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Debug)]
pub enum MatchState {
    Open,
    Staked,
    Settled,
}

#[account]
pub struct Match {
    pub match_id: String,       // 4 + 32 bytes max = 36
    pub player_one: Pubkey,     // 32
    pub player_two: Pubkey,     // 32
    pub oracle: Pubkey,         // 32
    pub treasury: Pubkey,       // 32  ← developer fee destination
    pub fee_bps: u16,           // 2   ← basis points (100 = 1%)
    pub stake_lamports: u64,    // 8
    pub p1_staked: bool,        // 1
    pub p2_staked: bool,        // 1
    pub state: MatchState,      // 1
    pub winner: Option<Pubkey>, // 33
    pub vault_bump: u8,         // 1
}

impl Match {
    // 8 (discriminator) + 36 + 32*4 + 2 + 8 + 1 + 1 + 1 + 33 + 1
    pub const SIZE: usize = 219;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum PitchError {
    #[msg("Signer is not a player in this match")]
    NotAPlayer,
    #[msg("This player has already staked")]
    AlreadyStaked,
    #[msg("Match must be in Staked state")]
    NotStaked,
    #[msg("Match is already settled")]
    AlreadySettled,
    #[msg("winner must be player_one or player_two")]
    InvalidWinner,
    #[msg("match_id must be 32 characters or fewer")]
    MatchIdTooLong,
    #[msg("fee_bps cannot exceed 1000 (10%)")]
    FeeTooHigh,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ─── Account contexts ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(match_id: String)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub player_one: Signer<'info>,

    #[account(
        init,
        payer = player_one,
        space = Match::SIZE,
        seeds = [b"match", match_id.as_bytes()],
        bump,
    )]
    pub match_account: Account<'info, Match>,

    /// CHECK: PDA that holds staked lamports; system-owned, no data
    #[account(
        mut,
        seeds = [b"vault", match_id.as_bytes()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: String)]
pub struct Stake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"match", match_id.as_bytes()],
        bump,
    )]
    pub match_account: Account<'info, Match>,

    /// CHECK: vault receives lamports from signer
    #[account(
        mut,
        seeds = [b"vault", match_id.as_bytes()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: String)]
pub struct Settle<'info> {
    /// Must be the oracle recorded at match creation (enforced by has_one)
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(
        mut,
        seeds = [b"match", match_id.as_bytes()],
        bump,
        has_one = oracle,
    )]
    pub match_account: Account<'info, Match>,

    /// CHECK: vault sends the pot to the winner
    #[account(
        mut,
        seeds = [b"vault", match_id.as_bytes()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: receives pot minus fee; must be player_one or player_two (checked in handler)
    #[account(mut)]
    pub winner_account: SystemAccount<'info>,

    /// CHECK: receives platform fee; must match match_account.treasury
    #[account(
        mut,
        constraint = treasury.key() == match_account.treasury @ PitchError::InvalidWinner,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: String)]
pub struct Refund<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,

    #[account(
        mut,
        seeds = [b"match", match_id.as_bytes()],
        bump,
        has_one = oracle,
    )]
    pub match_account: Account<'info, Match>,

    /// CHECK: vault sends stake back to each player
    #[account(
        mut,
        seeds = [b"vault", match_id.as_bytes()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: player_one receives their stake back
    #[account(mut)]
    pub player_one_account: SystemAccount<'info>,

    /// CHECK: player_two receives their stake back
    #[account(mut)]
    pub player_two_account: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}
