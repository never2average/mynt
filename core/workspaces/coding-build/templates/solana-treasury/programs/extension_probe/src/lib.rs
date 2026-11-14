use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

declare_id!("5dsKLv4kGHG57V29AP23UNunJGvfPoen1CCXYYFE7anb");

/// The treasury this probe extends (the template's placeholder address).
pub const TREASURY_ID: Pubkey = pubkey!("DCw4DC1HrhApHAWMxNhrKxw7XGHWGHndAMqVFfp13bJz");

/// A test fixture, never deployed: the treasury's extension contract seen from the extension's side. In mode 0 it
/// records each hook it gets (what a well-behaved extension does). In mode 1 it is hostile: it tries to move the
/// vault's USDC to an account of its choosing, with the pool (the vault's owner) as the authority, which the runtime
/// must refuse because the treasury never signs for the pool when it calls an extension.
#[program]
pub mod extension_probe {
    use super::*;

    pub fn init_probe(ctx: Context<InitProbe>, mode: u8) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.mode = mode;
        probe.calls = 0;
        probe.bump = ctx.bumps.probe;
        Ok(())
    }

    pub fn set_mode(ctx: Context<SetMode>, mode: u8) -> Result<()> {
        ctx.accounts.probe.mode = mode;
        Ok(())
    }

    /// The treasury's hook (its discriminator is sha256("global:on_treasury_event")[..8]).
    pub fn on_treasury_event<'info>(
        ctx: Context<'_, '_, 'info, 'info, OnTreasuryEvent<'info>>,
        kind: u8,
        pool: Pubkey,
        depositor: Pubkey,
        record: Pubkey,
        amount: u64,
        seq: u64,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.pool.key(), pool);
        // What every extension should do: accept the hook only when the treasury's hook PDA for this pool signed it.
        let (hook, _) = Pubkey::find_program_address(&[b"hook", pool.as_ref()], &TREASURY_ID);
        require_keys_eq!(ctx.accounts.hook.key(), hook, ProbeError::NotTheTreasury);
        require_keys_eq!(ctx.accounts.record.key(), record);
        let probe = &mut ctx.accounts.probe;
        probe.calls += 1;
        probe.last_kind = kind;
        probe.last_amount = amount;
        probe.last_seq = seq;
        probe.last_depositor = depositor;
        probe.pool_was_signer = ctx.accounts.pool.is_signer;
        probe.hook_was_signer = ctx.accounts.hook.is_signer;
        probe.pool_was_writable = ctx.accounts.pool.is_writable;
        if probe.mode == 1 {
            // remaining: [vault, destination token account, token program]
            let [vault, to, token_program] = ctx.remaining_accounts else { return err!(ProbeError::Accounts) };
            let mut data = vec![3u8]; // SPL Token Transfer
            data.extend_from_slice(&amount.to_le_bytes());
            let ix = Instruction {
                program_id: token_program.key(),
                accounts: vec![AccountMeta::new(vault.key(), false), AccountMeta::new(to.key(), false), AccountMeta::new_readonly(pool, true)],
                data,
            };
            invoke(&ix, &[vault.clone(), to.clone(), ctx.accounts.pool.to_account_info(), token_program.clone()])?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitProbe<'info> {
    #[account(init, payer = payer, space = 8 + Probe::INIT_SPACE, seeds = [b"probe"], bump)]
    pub probe: Account<'info, Probe>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMode<'info> {
    #[account(mut, seeds = [b"probe"], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
}

#[derive(Accounts)]
pub struct OnTreasuryEvent<'info> {
    /// The treasury's hook PDA for the pool, the only signer of the call.
    pub hook: Signer<'info>,
    /// CHECK: the treasury's pool, read-only.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the deposit or request record, read-only.
    pub record: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"probe"], bump = probe.bump)]
    pub probe: Account<'info, Probe>,
}

#[account]
#[derive(InitSpace)]
pub struct Probe {
    pub mode: u8,
    pub calls: u64,
    pub last_kind: u8,
    pub last_amount: u64,
    pub last_seq: u64,
    pub last_depositor: Pubkey,
    pub pool_was_signer: bool,
    pub pool_was_writable: bool,
    pub hook_was_signer: bool,
    pub bump: u8,
}

#[error_code]
pub enum ProbeError {
    #[msg("expected the vault, a destination and the token program")]
    Accounts,
    #[msg("the hook wasn't signed by the treasury's hook PDA for this pool")]
    NotTheTreasury,
}
