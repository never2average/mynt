use anchor_lang::prelude::*;

declare_id!("HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw");

#[program]
pub mod p {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.ledger.authority = ctx.accounts.authority.key();
        ctx.accounts.ledger.count = 0;
        Ok(())
    }
    pub fn tally(ctx: Context<Record>) -> Result<()> {
        let n = ctx.remaining_accounts.len() as u64;
        ctx.accounts.ledger.count = n;
        Ok(())
    }
    pub fn record(ctx: Context<Record>) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.count = ledger.count.checked_add(1).ok_or(E::Full)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Ledger::INIT_SPACE, seeds = [b"ledger", authority.key().as_ref()], bump)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Record<'info> {
    #[account(mut, has_one = authority, seeds = [b"ledger", authority.key().as_ref()], bump)]
    pub ledger: Account<'info, Ledger>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub authority: Pubkey,
    pub count: u64,
}

#[error_code]
pub enum E {
    Full,
}
