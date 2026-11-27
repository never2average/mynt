use anchor_lang::prelude::*;

declare_id!("HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw");

// A fixture for Mynt's mainnet program gate: closing a ledger sends its lamports to whatever account the caller
// names as `receiver`, which never signs. Closes must pay out to a signer, so this must be refused.
#[program]
pub mod lamport_drain {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.ledger.authority = ctx.accounts.authority.key();
        Ok(())
    }

    pub fn close_ledger(_ctx: Context<CloseLedger>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + 32, seeds = [b"ledger", authority.key().as_ref()], bump)]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLedger<'info> {
    #[account(mut, has_one = authority, close = receiver)]
    pub ledger: Account<'info, Ledger>,
    pub authority: Signer<'info>,
    /// CHECK: where the ledger's rent goes
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,
}

#[account]
pub struct Ledger {
    pub authority: Pubkey,
}
