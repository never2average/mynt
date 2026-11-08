use anchor_lang::prelude::*;

// Replaced by the address Mynt reserved for this program (reserve_program_id); scripts/scaffold_program.py
// writes it here and in Anchor.toml.
declare_id!("EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME");

/// A minimal ledger: each authority keeps a count of the entries it has recorded, and every entry emits an
/// event that Mynt's indexer forwards to the owning firm's webhooks. It holds no tokens and moves no funds.
#[program]
pub mod mynt_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.authority = ctx.accounts.authority.key();
        ledger.count = 0;
        ledger.bump = ctx.bumps.ledger;
        Ok(())
    }

    pub fn record(ctx: Context<RecordEntry>, reference: u64, digest: [u8; 32]) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.count = ledger.count.checked_add(1).ok_or(LedgerError::Full)?;
        emit!(EntryRecorded {
            authority: ledger.authority,
            count: ledger.count,
            reference,
            digest,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [b"ledger", authority.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordEntry<'info> {
    #[account(
        mut,
        seeds = [b"ledger", authority.key().as_ref()],
        bump = ledger.bump,
        has_one = authority
    )]
    pub ledger: Account<'info, Ledger>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub authority: Pubkey,
    pub count: u64,
    pub bump: u8,
}

#[event]
pub struct EntryRecorded {
    pub authority: Pubkey,
    pub count: u64,
    pub reference: u64,
    pub digest: [u8; 32],
}

#[error_code]
pub enum LedgerError {
    #[msg("The ledger's count can't grow any further")]
    Full,
}
