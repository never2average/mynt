use anchor_lang::prelude::*;

declare_id!("HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw");

#[program]
pub mod p {
    use super::*;
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        other::cpi::record(CpiContext::new(ctx.accounts.other_program.to_account_info(), other::cpi::accounts::Record { ledger: ctx.accounts.ledger.to_account_info() }))?;
        // After the CPI: unload() reads the account again without checking its owner or discriminator.
        let ledger = ctx.accounts.ledger.unload()?;
        require!(ledger.count < 10, E::Full);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Bump<'info> {
    #[account(mut)]
    pub ledger: LazyAccount<'info, Ledger>,
    pub other_program: Program<'info, Other>,
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
