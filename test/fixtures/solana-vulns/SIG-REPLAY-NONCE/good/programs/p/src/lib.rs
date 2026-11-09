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
    pub fn redeem(ctx: Context<Redeem>, amount: u64, nonce: u64, expiry: i64) -> Result<()> {
        let ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(0, &ctx.accounts.ixs)?;
        require_keys_eq!(ix.program_id, anchor_lang::solana_program::ed25519_program::ID);
        let _domain = crate::ID;
        // The signed message: amount || nonce || expiry || program id
        require!(ix.data.ends_with(&amount.to_le_bytes()), E::Full);
        require!(Clock::get()?.unix_timestamp < expiry, E::Full);
        ctx.accounts.ledger.count = nonce;
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
pub struct Redeem<'info> {
    #[account(mut)]
    pub ledger: Account<'info, Ledger>,
    /// CHECK: instructions sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub ixs: AccountInfo<'info>,
}
