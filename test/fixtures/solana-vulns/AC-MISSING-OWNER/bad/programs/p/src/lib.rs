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
    pub fn read(ctx: Context<Read>) -> Result<()> {
        let cfg = Config::try_from_slice(&ctx.accounts.config.data.borrow())?;
        msg!("{}", cfg.limit);
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

#[derive(Accounts)]
pub struct Read<'info> {
    /// CHECK: read by hand
    pub config: AccountInfo<'info>,
}
