use anchor_lang::prelude::*;

declare_id!("HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw");

// A sample for Mynt's agent benchmarks, never deployed: a ledger whose reset takes any signer.
#[program]
pub mod unchecked_ledger {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.authority = ctx.accounts.authority.key();
        ledger.count = 0;
        ledger.bump = ctx.bumps.ledger;
        Ok(())
    }

    pub fn record(ctx: Context<RecordEntry>, reference: u64) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.count = ledger.count.checked_add(1).ok_or(LedgerError::Full)?;
        emit!(EntryRecorded {
            authority: ledger.authority,
            count: ledger.count,
            reference,
        });
        Ok(())
    }

    pub fn reset(ctx: Context<ResetLedger>) -> Result<()> {
        ctx.accounts.ledger.count = 0;
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

#[derive(Accounts)]
pub struct ResetLedger<'info> {
    #[account(mut)]
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
}

#[error_code]
pub enum LedgerError {
    #[msg("The ledger's count can't grow any further")]
    Full,
}
