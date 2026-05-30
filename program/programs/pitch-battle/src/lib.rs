use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Placeholder — replace with the key from target/deploy/pitch_battle-keypair.json after `anchor build`
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod pitch_battle {
    use super::*;

    /// P1 creates the match and records the oracle pubkey.
    /// The vault PDA is derived here so its bump is stored for later CPI signing.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: String,
        stake_lamports: u64,
        player_two: Pubkey,
        oracle: Pubkey,
    ) -> Result<()> {
        require!(match_id.len() <= 32, PitchError::MatchIdTooLong);
        let m = &mut ctx.accounts.match_account;
        m.match_id = match_id;
        m.player_one = ctx.accounts.player_one.key();
        m.player_two = player_two;
        m.oracle = oracle;
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

    /// Oracle-only. Transfers the full pot (2 × stake) from the vault to the winner.
    /// `has_one = oracle` on the accounts struct enforces the oracle check.
    pub fn settle(ctx: Context<Settle>, match_id: String, winner: Pubkey) -> Result<()> {
        let player_one = ctx.accounts.match_account.player_one;
        let player_two = ctx.accounts.match_account.player_two;
        let pot = ctx.accounts.match_account
            .stake_lamports
            .checked_mul(2)
            .ok_or(PitchError::Overflow)?;
        let vault_bump = ctx.accounts.match_account.vault_bump;

        require!(
            ctx.accounts.match_account.state == MatchState::Staked,
            PitchError::NotStaked
        );
        require!(
            winner == player_one || winner == player_two,
            PitchError::InvalidWinner
        );

        ctx.accounts.match_account.winner = Some(winner);
        ctx.accounts.match_account.state = MatchState::Settled;

        let seeds: &[&[u8]] = &[b"vault", match_id.as_bytes(), &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_account.to_account_info(),
                },
                &[seeds],
            ),
            pot,
        )?;

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
    pub match_id: String,       // 4 + 32 bytes max
    pub player_one: Pubkey,     // 32
    pub player_two: Pubkey,     // 32
    pub oracle: Pubkey,         // 32
    pub stake_lamports: u64,    // 8
    pub p1_staked: bool,        // 1
    pub p2_staked: bool,        // 1
    pub state: MatchState,      // 1
    pub winner: Option<Pubkey>, // 33
    pub vault_bump: u8,         // 1
}

impl Match {
    // 8 (discriminator) + 36 + 32 + 32 + 32 + 8 + 1 + 1 + 1 + 33 + 1
    pub const SIZE: usize = 185;
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

    /// CHECK: receives 2 × stake_lamports
    #[account(mut)]
    pub winner_account: SystemAccount<'info>,

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
