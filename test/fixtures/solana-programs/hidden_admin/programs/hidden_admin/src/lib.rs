use anchor_lang::prelude::*;

declare_id!("HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw");

// A fixture for Mynt's mainnet program gate: a ledger with a hidden admin. A hard-coded key can rewrite any
// ledger, and anyone can hand a ledger's authority to an account that never signed. Both must be refused.
const ADMIN: Pubkey = pubkey!("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

#[program]
pub mod hidden_admin {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let ledger = &mut ctx.accounts.ledger;
        ledger.authority = ctx.accounts.authority.key();
        ledger.count = 0;
        Ok(())
    }

    // Only the hard-coded admin may reset any ledger.
    pub fn reset(ctx: Context<Reset>) -> Result<()> {
        require_keys_eq!(ctx.accounts.admin.key(), ADMIN);
        ctx.accounts.ledger.count = 0;
        Ok(())
    }

    // Hands the ledger to any address, without the new authority signing.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.ledger.authority = new_authority;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 32 + 8, seeds = [b"ledger", authority.key().as_ref()], bump)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reset<'info> {
    #[account(mut)]
    pub ledger: Account<'info, Ledger>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(mut, has_one = authority)]
    pub ledger: Account<'info, Ledger>,
    pub authority: Signer<'info>,
}

#[account]
pub struct Ledger {
    pub authority: Pubkey,
    pub count: u64,
}
