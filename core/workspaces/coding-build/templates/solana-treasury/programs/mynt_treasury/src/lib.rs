use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::sysvar::instructions as instructions_sysvar;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod attestation;

// A placeholder nobody holds a key for. Each app's treasury is deployed at the address Mynt reserved for it; the
// template's own build (and the hash in schemas/solana-treasury-template.json) is at this one.
declare_id!("DCw4DC1HrhApHAWMxNhrKxw7XGHWGHndAMqVFfp13bJz");

/// Mynt's treasury template. A liquidity pool's capital is held as USDC in a token account owned by the pool's PDA.
/// Nothing can move it but two paths, both to the depositor's own associated token account: paying the withdrawal
/// queue from its head (permissionless, after the notice period, never below the reserve floor and only from the
/// deposit the request was made against, once it's unlocked), and refunding a rejected deposit. The pool's authority
/// (a Squads vault in production) can pause new deposits, propose timelocked terms that can never go below the
/// product floor recorded at initialisation, and reject deposits; it can never pause exits or take funds.
///
/// Patterns: the PDA-owned vault, two-step withdrawal with a cooldown, deposit capacity and split roles are Jito
/// Restaking's vault program's; the ed25519 approver attestations and the redemption queue with partial fills are
/// OnRe's onre-sol (see UPSTREAM.json).
#[program]
pub mod mynt_treasury {
    use super::*;

    /// Opens a pool: its terms and the product floor they can never go below are account state, not code.
    pub fn initialize_pool(ctx: Context<InitializePool>, pool_id: u64, terms: Terms, floor: ProductFloor, min_timelock_seconds: i64) -> Result<()> {
        validate_floor(&floor)?;
        validate_terms(&terms, &floor)?;
        require!(min_timelock_seconds > 0 && min_timelock_seconds >= terms.notice_seconds, TreasuryError::TimelockTooShort);
        require_keys_neq!(ctx.accounts.authority.key(), Pubkey::default(), TreasuryError::InvalidTerms);
        let pool = &mut ctx.accounts.pool;
        pool.creator = ctx.accounts.creator.key();
        pool.pool_id = pool_id;
        pool.authority = ctx.accounts.authority.key();
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.terms = terms;
        pool.floor = floor;
        pool.min_timelock_seconds = min_timelock_seconds;
        pool.pending_terms = terms;
        pool.pending_effective_at = 0;
        pool.has_pending_terms = false;
        pool.sponsor_paused = false;
        pool.health_paused = false;
        pool.obligations = 0;
        pool.obligations_as_of = 0;
        pool.total_principal = 0;
        pool.total_queued = 0;
        pool.next_deposit_seq = 0;
        pool.next_request_seq = 0;
        pool.head_seq = 0;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;
        emit!(PoolInitialized {
            pool: pool.key(),
            creator: pool.creator,
            authority: pool.authority,
            usdc_mint: pool.usdc_mint,
            vault: pool.vault,
            terms,
            floor,
            min_timelock_seconds,
        });
        Ok(())
    }

    /// A deposit from an allow-listed depositor: the instruction just before must be an Ed25519 verification of the
    /// pool's deposit approval for this depositor by one of the pool's attesters, not yet expired. Each deposit is
    /// its own record, with the lock-in copied from the terms in force now.
    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, MakeDeposit<'info>>, amount: u64, approval_expiry: i64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let depositor = ctx.accounts.depositor.key();
        {
            let pool = &ctx.accounts.pool;
            require!(!pool.sponsor_paused, TreasuryError::DepositsPaused);
            require!(!pool.health_paused || pool.terms.topups_when_health_paused, TreasuryError::DepositsPausedForHealth);
            require!(approval_expiry >= now, TreasuryError::AttestationExpired);
            let expected = deposit_approval_message(&pool_key, &depositor, approval_expiry);
            attestation::verify_attestation(&ctx.accounts.instructions.to_account_info(), &pool.terms.attesters, &expected)?;
        }

        let position = &mut ctx.accounts.position;
        if position.depositor == Pubkey::default() {
            position.pool = pool_key;
            position.depositor = depositor;
            position.bump = ctx.bumps.position;
        }
        let principal = position.principal.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        require!(principal <= ctx.accounts.pool.terms.commitment_max, TreasuryError::AboveCommitmentMax);
        require!(principal >= ctx.accounts.pool.terms.commitment_min, TreasuryError::BelowCommitmentMin);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_token.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        position.principal = principal;
        position.deposits = position.deposits.checked_add(1).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        let seq = pool.next_deposit_seq;
        let lock_in = pool.terms.lock_in_seconds;
        let record = &mut ctx.accounts.deposit;
        record.pool = pool_key;
        record.depositor = depositor;
        record.seq = seq;
        record.amount = amount;
        record.remaining = amount;
        record.queued = 0;
        record.settled_at = now;
        record.lock_in_seconds = lock_in;
        record.unlock_at = now.checked_add(lock_in).ok_or(TreasuryError::Overflow)?;
        record.rejected = false;
        record.bump = ctx.bumps.deposit;
        pool.next_deposit_seq = seq.checked_add(1).ok_or(TreasuryError::Overflow)?;
        pool.total_principal = pool.total_principal.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        emit!(DepositMade {
            pool: pool_key,
            depositor,
            deposit: record.key(),
            seq,
            amount,
            settled_at: now,
            unlock_at: record.unlock_at,
            principal_after: principal,
        });

        // The extension sees the records as they now stand.
        let extension = pool.terms.extension_program;
        ctx.accounts.deposit.exit(&crate::ID)?;
        ctx.accounts.position.exit(&crate::ID)?;
        ctx.accounts.pool.exit(&crate::ID)?;
        let called = run_extension(
            extension,
            ctx.accounts.extension_program.as_ref(),
            true,
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.deposit.to_account_info(),
            ctx.remaining_accounts,
            HookArgs { kind: HOOK_DEPOSIT, pool: pool_key, depositor, record: ctx.accounts.deposit.key(), amount, seq },
        )?;
        if extension != Pubkey::default() {
            emit!(ExtensionHook { pool: pool_key, program: extension, kind: HOOK_DEPOSIT, called });
        }
        Ok(())
    }

    /// Rejects a deposit (for instance, funds the compliance review refuses): what's left of it goes back to the
    /// depositor's own associated token account, and any request against it can never be paid. The only path out
    /// of the vault besides the queue, and it can only pay the depositor.
    pub fn reject_deposit(ctx: Context<RejectDeposit>) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let refund = ctx.accounts.deposit.remaining;
        require!(!ctx.accounts.deposit.rejected, TreasuryError::DepositRejected);
        require!(refund > 0, TreasuryError::ZeroAmount);
        let (creator, id_bytes, bump) = (ctx.accounts.pool.creator, ctx.accounts.pool.pool_id.to_le_bytes(), [ctx.accounts.pool.bump]);
        let seeds: &[&[u8]] = &[b"pool", creator.as_ref(), &id_bytes, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.depositor_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            refund,
            ctx.accounts.usdc_mint.decimals,
        )?;
        let deposit = &mut ctx.accounts.deposit;
        deposit.remaining = 0;
        deposit.rejected = true;
        let position = &mut ctx.accounts.position;
        position.principal = position.principal.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_principal = pool.total_principal.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        emit!(DepositRejected { pool: pool_key, depositor: deposit.depositor, deposit: deposit.key(), seq: deposit.seq, refunded: refund });
        Ok(())
    }

    /// Joins the withdrawal queue against one deposit, which must be unlocked now: the amount is at most what's
    /// left of it less what's already queued against it. Payable once the notice period in force now has passed.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let deposit = &mut ctx.accounts.deposit;
        require!(!deposit.rejected, TreasuryError::DepositRejected);
        require!(now >= deposit.unlock_at, TreasuryError::DepositLocked);
        let free = deposit.remaining.checked_sub(deposit.queued).ok_or(TreasuryError::Overflow)?;
        require!(amount <= free, TreasuryError::ExceedsUnlocked);
        deposit.queued = deposit.queued.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        let seq = pool.next_request_seq;
        let request = &mut ctx.accounts.request;
        request.pool = pool_key;
        request.depositor = deposit.depositor;
        request.deposit = deposit.key();
        request.seq = seq;
        request.amount = amount;
        request.remaining = amount;
        request.paid = 0;
        request.requested_at = now;
        request.payable_at = now.checked_add(pool.terms.notice_seconds).ok_or(TreasuryError::Overflow)?;
        request.status = REQUEST_OPEN;
        request.bump = ctx.bumps.request;
        pool.next_request_seq = seq.checked_add(1).ok_or(TreasuryError::Overflow)?;
        pool.total_queued = pool.total_queued.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        emit!(WithdrawalRequested {
            pool: pool_key,
            depositor: request.depositor,
            deposit: request.deposit,
            request: request.key(),
            seq,
            amount,
            payable_at: request.payable_at,
        });
        Ok(())
    }

    /// The depositor withdraws an open request; the queue skips it when it reaches the head.
    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        let request = &mut ctx.accounts.request;
        require!(request.status == REQUEST_OPEN, TreasuryError::RequestClosed);
        let left = request.remaining;
        request.remaining = 0;
        request.status = REQUEST_CANCELLED;
        let deposit = &mut ctx.accounts.deposit;
        deposit.queued = deposit.queued.checked_sub(left).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_queued = pool.total_queued.checked_sub(left).ok_or(TreasuryError::Overflow)?;
        emit!(RequestCancelled { pool: pool.key(), depositor: request.depositor, request: request.key(), seq: request.seq, amount: left });
        Ok(())
    }

    /// Permissionless: pays the request at the head of the queue, as far as the vault allows above the reserve
    /// floor. A partial fill keeps the request at the head; nothing behind it is paid until it's done. At pay time the
    /// deposit is checked again: a rejected deposit voids the request, and a locked one is never paid.
    pub fn process_queue<'info>(ctx: Context<'_, '_, 'info, 'info, ProcessQueue<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let seq = ctx.accounts.request.seq;
        let depositor = ctx.accounts.request.depositor;

        if ctx.accounts.request.status != REQUEST_OPEN {
            return advance_head(&mut ctx.accounts.pool);
        }
        if ctx.accounts.deposit.rejected || ctx.accounts.deposit.remaining == 0 {
            let left = ctx.accounts.request.remaining;
            let request = &mut ctx.accounts.request;
            request.remaining = 0;
            request.status = REQUEST_VOIDED;
            let deposit = &mut ctx.accounts.deposit;
            deposit.queued = deposit.queued.saturating_sub(left);
            let pool = &mut ctx.accounts.pool;
            pool.total_queued = pool.total_queued.checked_sub(left).ok_or(TreasuryError::Overflow)?;
            emit!(RequestVoided { pool: pool_key, depositor, request: request.key(), seq, amount: left });
            return advance_head(pool);
        }
        require!(now >= ctx.accounts.deposit.unlock_at, TreasuryError::DepositLocked);
        require!(now >= ctx.accounts.request.payable_at, TreasuryError::NoticeNotElapsed);

        let floor = reserve_floor(&ctx.accounts.pool);
        let available = ctx.accounts.vault.amount.saturating_sub(floor);
        let pay = ctx.accounts.request.remaining.min(available).min(ctx.accounts.deposit.remaining);
        require!(pay > 0, TreasuryError::ReserveFloor);

        let (creator, id_bytes, bump) = (ctx.accounts.pool.creator, ctx.accounts.pool.pool_id.to_le_bytes(), [ctx.accounts.pool.bump]);
        let seeds: &[&[u8]] = &[b"pool", creator.as_ref(), &id_bytes, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.requester_token.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            pay,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let request = &mut ctx.accounts.request;
        request.remaining -= pay;
        request.paid = request.paid.checked_add(pay).ok_or(TreasuryError::Overflow)?;
        let remaining = request.remaining;
        let deposit = &mut ctx.accounts.deposit;
        deposit.remaining = deposit.remaining.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        deposit.queued = deposit.queued.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        let position = &mut ctx.accounts.position;
        position.principal = position.principal.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_principal = pool.total_principal.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        pool.total_queued = pool.total_queued.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        let vault_after = ctx.accounts.vault.amount - pay;
        emit!(WithdrawalPaid {
            pool: pool_key,
            depositor,
            request: ctx.accounts.request.key(),
            seq,
            amount: pay,
            remaining,
            partial: remaining > 0,
            reserve_floor: floor,
            vault_after,
        });
        if remaining == 0 {
            ctx.accounts.request.status = REQUEST_PAID;
            advance_head(&mut ctx.accounts.pool)?;
        }

        // Best effort on exits: whoever cranks the queue may leave the extension out, so it can never hold up an exit.
        let extension = ctx.accounts.pool.terms.extension_program;
        if extension != Pubkey::default() {
            ctx.accounts.request.exit(&crate::ID)?;
            ctx.accounts.deposit.exit(&crate::ID)?;
            ctx.accounts.position.exit(&crate::ID)?;
            ctx.accounts.pool.exit(&crate::ID)?;
            let called = run_extension(
                extension,
                ctx.accounts.extension_program.as_ref(),
                false,
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.request.to_account_info(),
                ctx.remaining_accounts,
                HookArgs { kind: HOOK_WITHDRAWAL_PAID, pool: pool_key, depositor, record: ctx.accounts.request.key(), amount: pay, seq },
            )?;
            emit!(ExtensionHook { pool: pool_key, program: extension, kind: HOOK_WITHDRAWAL_PAID, called });
        }
        Ok(())
    }

    /// The authority pauses or resumes new deposits. Exits have no pause.
    pub fn set_sponsor_pause(ctx: Context<AuthorityOnly>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.sponsor_paused = paused;
        emit!(PauseChanged { pool: pool.key(), sponsor_paused: pool.sponsor_paused, health_paused: pool.health_paused, by: ctx.accounts.authority.key() });
        Ok(())
    }

    /// The authority or the pool's health authority pauses deposits for the pool's health. Top-ups continue while
    /// health-paused if the terms say so. Exits have no pause.
    pub fn set_health_pause(ctx: Context<HealthPause>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let signer = ctx.accounts.signer.key();
        require!(
            signer == pool.authority || (pool.terms.health_authority != Pubkey::default() && signer == pool.terms.health_authority),
            TreasuryError::Unauthorized
        );
        pool.health_paused = paused;
        emit!(PauseChanged { pool: pool.key(), sponsor_paused: pool.sponsor_paused, health_paused: pool.health_paused, by: signer });
        Ok(())
    }

    /// Proposes new terms, effective no sooner than the pool's timelock and the notice period in force (so anyone
    /// who dislikes them can be out first). They can never go below the product floor.
    pub fn propose_terms(ctx: Context<AuthorityOnly>, terms: Terms, effective_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        validate_terms(&terms, &pool.floor)?;
        let wait = pool.min_timelock_seconds.max(pool.terms.notice_seconds);
        require!(effective_at >= now.checked_add(wait).ok_or(TreasuryError::Overflow)?, TreasuryError::TimelockTooShort);
        pool.pending_terms = terms;
        pool.pending_effective_at = effective_at;
        pool.has_pending_terms = true;
        emit!(TermsProposed { pool: pool.key(), terms, effective_at });
        Ok(())
    }

    /// The authority withdraws proposed terms.
    pub fn cancel_terms(ctx: Context<AuthorityOnly>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.has_pending_terms, TreasuryError::NoPendingTerms);
        pool.has_pending_terms = false;
        pool.pending_effective_at = 0;
        emit!(TermsCancelled { pool: pool.key() });
        Ok(())
    }

    /// Permissionless, once proposed terms are effective. Deposits already made keep their own lock-in, and requests
    /// already made their payable time.
    pub fn apply_terms(ctx: Context<ApplyTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(pool.has_pending_terms, TreasuryError::NoPendingTerms);
        require!(now >= pool.pending_effective_at, TreasuryError::TermsNotEffective);
        validate_terms(&pool.pending_terms, &pool.floor)?;
        pool.terms = pool.pending_terms;
        pool.has_pending_terms = false;
        pool.pending_effective_at = 0;
        emit!(TermsApplied { pool: pool.key(), terms: pool.terms });
        Ok(())
    }

    /// Records the obligations figure the reserve's bps part is measured against: an Ed25519 attestation by one of
    /// the pool's attesters, newer than the last and no older than the terms' maximum staleness.
    pub fn attest_obligations(ctx: Context<AttestObligations>, obligations: u64, as_of: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(as_of <= now, TreasuryError::AttestationExpired);
        require!(now.checked_sub(as_of).ok_or(TreasuryError::Overflow)? <= pool.terms.obligations_max_staleness, TreasuryError::AttestationStale);
        require!(as_of > pool.obligations_as_of, TreasuryError::AttestationStale);
        let expected = obligations_message(&pool_key, obligations, as_of);
        let attester = attestation::verify_attestation(&ctx.accounts.instructions.to_account_info(), &pool.terms.attesters, &expected)?;
        pool.obligations = obligations;
        pool.obligations_as_of = as_of;
        emit!(ObligationsAttested { pool: pool_key, obligations, as_of, attester, reserve_floor: reserve_floor(pool) });
        Ok(())
    }

    /// Permissionless: emits the pool's figures for Mynt's indexer, which fingerprints them into product-health.
    pub fn snapshot(ctx: Context<Snapshot>) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &ctx.accounts.pool;
        emit!(PoolSnapshot {
            pool: pool.key(),
            vault_balance: ctx.accounts.vault.amount,
            total_principal: pool.total_principal,
            total_queued: pool.total_queued,
            reserve_floor: reserve_floor(pool),
            obligations: pool.obligations,
            obligations_as_of: pool.obligations_as_of,
            head_seq: pool.head_seq,
            next_request_seq: pool.next_request_seq,
            next_deposit_seq: pool.next_deposit_seq,
            sponsor_paused: pool.sponsor_paused,
            health_paused: pool.health_paused,
            slot: clock.slot,
            unix_timestamp: clock.unix_timestamp,
        });
        Ok(())
    }
}

// ---- rules ----

pub const MAX_BPS: u16 = 10_000;
pub const DEPOSIT_APPROVAL_DOMAIN: [u8; 8] = *b"MYNTDEP1";
pub const OBLIGATIONS_DOMAIN: [u8; 8] = *b"MYNTOBL1";
/// sha256("global:on_treasury_event")[..8]: an Anchor extension handles the hook as `on_treasury_event`.
pub const EXTENSION_HOOK_DISCRIMINATOR: [u8; 8] = [225, 98, 18, 23, 251, 52, 176, 175];
pub const HOOK_DEPOSIT: u8 = 0;
pub const HOOK_WITHDRAWAL_PAID: u8 = 1;
pub const REQUEST_OPEN: u8 = 0;
pub const REQUEST_PAID: u8 = 1;
pub const REQUEST_CANCELLED: u8 = 2;
pub const REQUEST_VOIDED: u8 = 3;

/// What an attester signs to allow a depositor into a pool until `expiry`.
pub fn deposit_approval_message(pool: &Pubkey, depositor: &Pubkey, expiry: i64) -> Vec<u8> {
    let mut m = Vec::with_capacity(112);
    m.extend_from_slice(&DEPOSIT_APPROVAL_DOMAIN);
    m.extend_from_slice(crate::ID.as_ref());
    m.extend_from_slice(pool.as_ref());
    m.extend_from_slice(depositor.as_ref());
    m.extend_from_slice(&expiry.to_le_bytes());
    m
}

/// What an attester signs to state a pool's obligations figure as of a time.
pub fn obligations_message(pool: &Pubkey, obligations: u64, as_of: i64) -> Vec<u8> {
    let mut m = Vec::with_capacity(88);
    m.extend_from_slice(&OBLIGATIONS_DOMAIN);
    m.extend_from_slice(crate::ID.as_ref());
    m.extend_from_slice(pool.as_ref());
    m.extend_from_slice(&obligations.to_le_bytes());
    m.extend_from_slice(&as_of.to_le_bytes());
    m
}

/// The least the vault must keep: the fixed floor, or the bps part of the last attested obligations, whichever is
/// more. A stale figure isn't dropped (that would lower the floor); a newer attestation replaces it.
pub fn reserve_floor(pool: &Pool) -> u64 {
    let bps = (pool.obligations as u128 * pool.terms.min_reserve_bps as u128 / MAX_BPS as u128) as u64;
    pool.terms.min_reserve.max(bps)
}

fn validate_floor(f: &ProductFloor) -> Result<()> {
    require!(f.min_lock_in_seconds >= 0 && f.min_notice_seconds >= 0, TreasuryError::InvalidTerms);
    require!(f.min_reserve_bps <= MAX_BPS, TreasuryError::InvalidTerms);
    require!(f.max_obligations_staleness > 0, TreasuryError::InvalidTerms);
    require!(f.max_commitment > 0 && f.min_commitment <= f.max_commitment, TreasuryError::InvalidTerms);
    Ok(())
}

/// Terms are never laxer than the product floor: no shorter lock-in or notice, no lower reserve, no staler
/// obligations figure, no bigger commitment per depositor, and top-ups during a health pause only if the floor
/// allows them.
fn validate_terms(t: &Terms, f: &ProductFloor) -> Result<()> {
    require!(t.min_reserve_bps <= MAX_BPS && t.obligations_max_staleness > 0, TreasuryError::InvalidTerms);
    require!(t.commitment_max > 0 && t.commitment_min <= t.commitment_max, TreasuryError::InvalidTerms);
    require!(t.attesters.iter().any(|a| *a != Pubkey::default()), TreasuryError::InvalidTerms);
    require!(t.lock_in_seconds >= f.min_lock_in_seconds, TreasuryError::TermsBelowFloor);
    require!(t.notice_seconds >= f.min_notice_seconds, TreasuryError::TermsBelowFloor);
    require!(t.min_reserve >= f.min_reserve, TreasuryError::TermsBelowFloor);
    require!(t.min_reserve_bps >= f.min_reserve_bps, TreasuryError::TermsBelowFloor);
    require!(t.obligations_max_staleness <= f.max_obligations_staleness, TreasuryError::TermsBelowFloor);
    require!(t.commitment_min >= f.min_commitment, TreasuryError::TermsBelowFloor);
    require!(t.commitment_max <= f.max_commitment, TreasuryError::TermsBelowFloor);
    require!(!t.topups_when_health_paused || f.topups_when_health_paused_allowed, TreasuryError::TermsBelowFloor);
    require!(t.extension_program != crate::ID, TreasuryError::InvalidTerms);
    Ok(())
}

fn advance_head(pool: &mut Account<Pool>) -> Result<()> {
    pool.head_seq = pool.head_seq.checked_add(1).ok_or(TreasuryError::Overflow)?;
    emit!(QueueAdvanced { pool: pool.key(), head_seq: pool.head_seq });
    Ok(())
}

/// What an extension is called with, after the 8-byte hook discriminator.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct HookArgs {
    pub kind: u8,
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub record: Pubkey,
    pub amount: u64,
    pub seq: u64,
}

/// Calls the pool's extension, if it has one, with plain `invoke`: no signer seeds, so it can never sign as the pool
/// (the vault's owner). The pool and the record go read-only; the caller's extra accounts are forwarded never as
/// signers, and writable only when the extension itself owns them. The vault and every token account it could
/// touch are therefore read-only to it.
fn run_extension<'info>(
    extension: Pubkey,
    passed: Option<&UncheckedAccount<'info>>,
    required: bool,
    pool: AccountInfo<'info>,
    record: AccountInfo<'info>,
    forwarded: &[AccountInfo<'info>],
    args: HookArgs,
) -> Result<bool> {
    if extension == Pubkey::default() {
        return Ok(false);
    }
    let Some(program) = passed else {
        require!(!required, TreasuryError::ExtensionMissing);
        return Ok(false);
    };
    require_keys_eq!(program.key(), extension, TreasuryError::WrongExtension);
    require!(program.executable, TreasuryError::WrongExtension);
    let mut metas = vec![AccountMeta::new_readonly(pool.key(), false), AccountMeta::new_readonly(record.key(), false)];
    let mut infos = vec![pool, record];
    for a in forwarded {
        if a.is_writable {
            require_keys_eq!(*a.owner, extension, TreasuryError::ExtensionAccountNotWritable);
            metas.push(AccountMeta::new(a.key(), false));
        } else {
            metas.push(AccountMeta::new_readonly(a.key(), false));
        }
        infos.push(a.clone());
    }
    infos.push(program.to_account_info());
    let mut data = EXTENSION_HOOK_DISCRIMINATOR.to_vec();
    args.serialize(&mut data)?;
    invoke(&Instruction { program_id: extension, accounts: metas, data }, &infos)?;
    Ok(true)
}

// ---- accounts ----

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: any address: in production a Squads vault PDA with a time lock. It never signs here.
    pub authority: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", creator.key().as_ref(), &pool_id.to_le_bytes()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [b"vault", pool.key().as_ref()], bump, token::mint = usdc_mint, token::authority = pool)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MakeDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init_if_needed, payer = depositor, space = 8 + Position::INIT_SPACE, seeds = [b"position", pool.key().as_ref(), depositor.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(init, payer = depositor, space = 8 + DepositRecord::INIT_SPACE, seeds = [b"deposit", pool.key().as_ref(), &pool.next_deposit_seq.to_le_bytes()], bump)]
    pub deposit: Box<Account<'info, DepositRecord>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = depositor)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: must be the pool's extension program when it has one (checked in run_extension).
    pub extension_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RejectDeposit<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool)]
    pub deposit: Box<Account<'info, DepositRecord>>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), deposit.depositor.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Only ever the depositor's own associated token account.
    #[account(mut, address = get_associated_token_address(&deposit.depositor, &pool.usdc_mint))]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, has_one = depositor)]
    pub deposit: Box<Account<'info, DepositRecord>>,
    #[account(init, payer = depositor, space = 8 + WithdrawalRequest::INIT_SPACE, seeds = [b"request", pool.key().as_ref(), &pool.next_request_seq.to_le_bytes()], bump)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRequest<'info> {
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, has_one = depositor, has_one = deposit)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(mut)]
    pub deposit: Box<Account<'info, DepositRecord>>,
}

#[derive(Accounts)]
pub struct ProcessQueue<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// Strictly the head of the queue.
    #[account(mut, has_one = pool, has_one = deposit, seeds = [b"request", pool.key().as_ref(), &pool.head_seq.to_le_bytes()], bump = request.bump)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(mut, has_one = pool)]
    pub deposit: Box<Account<'info, DepositRecord>>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), request.depositor.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Only ever the requester's own associated token account (anyone may create it).
    #[account(mut, address = get_associated_token_address(&request.depositor, &pool.usdc_mint))]
    pub requester_token: Box<Account<'info, TokenAccount>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: the pool's extension program, or left out (checked in run_extension).
    pub extension_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct HealthPause<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct ApplyTerms<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct AttestObligations<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: the instructions sysvar, by address.
    #[account(address = instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    #[account(seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
}

// ---- state ----

/// A pool's terms: config, not code. Changed only by propose_terms → apply_terms, never below the product floor.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Terms {
    /// Each deposit is locked this long from when it settles (copied onto the deposit).
    pub lock_in_seconds: i64,
    /// A withdrawal request is payable this long after it's made (copied onto the request).
    pub notice_seconds: i64,
    /// The vault never pays below this (USDC base units)...
    pub min_reserve: u64,
    /// ...nor below this share of the last attested obligations figure.
    pub min_reserve_bps: u16,
    /// An obligations attestation older than this is refused.
    pub obligations_max_staleness: i64,
    /// Each depositor's total principal stays within these.
    pub commitment_min: u64,
    pub commitment_max: u64,
    /// Whether deposits continue while the pool is paused for health.
    pub topups_when_health_paused: bool,
    /// An app's own reviewed program called on deposits and payments, or the default key for none.
    pub extension_program: Pubkey,
    /// The keys whose Ed25519 attestations allow depositors and state obligations (the default key for an unused slot).
    pub attesters: [Pubkey; 2],
    /// Who besides the authority may pause deposits for health (the default key for nobody).
    pub health_authority: Pubkey,
}

/// What the product requires of every terms the pool ever has. Recorded at initialisation; nothing changes it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct ProductFloor {
    pub min_lock_in_seconds: i64,
    pub min_notice_seconds: i64,
    pub min_reserve: u64,
    pub min_reserve_bps: u16,
    pub max_obligations_staleness: i64,
    pub min_commitment: u64,
    pub max_commitment: u64,
    pub topups_when_health_paused_allowed: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub creator: Pubkey,
    pub pool_id: u64,
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub terms: Terms,
    pub floor: ProductFloor,
    pub min_timelock_seconds: i64,
    pub pending_terms: Terms,
    pub pending_effective_at: i64,
    pub has_pending_terms: bool,
    pub sponsor_paused: bool,
    pub health_paused: bool,
    pub obligations: u64,
    pub obligations_as_of: i64,
    /// What's left of every deposit (not yet paid out or refunded).
    pub total_principal: u64,
    /// What's left of every open withdrawal request.
    pub total_queued: u64,
    pub next_deposit_seq: u64,
    pub next_request_seq: u64,
    /// The sequence number of the request at the head of the queue (== next_request_seq when it's empty).
    pub head_seq: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// One depositor in one pool.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub principal: u64,
    pub deposits: u64,
    pub bump: u8,
}

/// One deposit, with its own lock-in.
#[account]
#[derive(InitSpace)]
pub struct DepositRecord {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub seq: u64,
    pub amount: u64,
    /// Not yet paid out or refunded.
    pub remaining: u64,
    /// In open withdrawal requests against this deposit.
    pub queued: u64,
    pub settled_at: i64,
    pub lock_in_seconds: i64,
    pub unlock_at: i64,
    pub rejected: bool,
    pub bump: u8,
}

/// One place in the withdrawal queue.
#[account]
#[derive(InitSpace)]
pub struct WithdrawalRequest {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub deposit: Pubkey,
    pub seq: u64,
    pub amount: u64,
    pub remaining: u64,
    pub paid: u64,
    pub requested_at: i64,
    pub payable_at: i64,
    pub status: u8,
    pub bump: u8,
}

// ---- events (every state change, for Mynt's indexer) ----

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub vault: Pubkey,
    pub terms: Terms,
    pub floor: ProductFloor,
    pub min_timelock_seconds: i64,
}

#[event]
pub struct DepositMade {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub deposit: Pubkey,
    pub seq: u64,
    pub amount: u64,
    pub settled_at: i64,
    pub unlock_at: i64,
    pub principal_after: u64,
}

#[event]
pub struct DepositRejected {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub deposit: Pubkey,
    pub seq: u64,
    pub refunded: u64,
}

#[event]
pub struct WithdrawalRequested {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub deposit: Pubkey,
    pub request: Pubkey,
    pub seq: u64,
    pub amount: u64,
    pub payable_at: i64,
}

#[event]
pub struct WithdrawalPaid {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub request: Pubkey,
    pub seq: u64,
    pub amount: u64,
    pub remaining: u64,
    pub partial: bool,
    pub reserve_floor: u64,
    pub vault_after: u64,
}

#[event]
pub struct RequestCancelled {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub request: Pubkey,
    pub seq: u64,
    pub amount: u64,
}

#[event]
pub struct RequestVoided {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub request: Pubkey,
    pub seq: u64,
    pub amount: u64,
}

#[event]
pub struct QueueAdvanced {
    pub pool: Pubkey,
    pub head_seq: u64,
}

#[event]
pub struct PauseChanged {
    pub pool: Pubkey,
    pub sponsor_paused: bool,
    pub health_paused: bool,
    pub by: Pubkey,
}

#[event]
pub struct TermsProposed {
    pub pool: Pubkey,
    pub terms: Terms,
    pub effective_at: i64,
}

#[event]
pub struct TermsCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct TermsApplied {
    pub pool: Pubkey,
    pub terms: Terms,
}

#[event]
pub struct ObligationsAttested {
    pub pool: Pubkey,
    pub obligations: u64,
    pub as_of: i64,
    pub attester: Pubkey,
    pub reserve_floor: u64,
}

#[event]
pub struct ExtensionHook {
    pub pool: Pubkey,
    pub program: Pubkey,
    pub kind: u8,
    pub called: bool,
}

#[event]
pub struct PoolSnapshot {
    pub pool: Pubkey,
    pub vault_balance: u64,
    pub total_principal: u64,
    pub total_queued: u64,
    pub reserve_floor: u64,
    pub obligations: u64,
    pub obligations_as_of: i64,
    pub head_seq: u64,
    pub next_request_seq: u64,
    pub next_deposit_seq: u64,
    pub sponsor_paused: bool,
    pub health_paused: bool,
    pub slot: u64,
    pub unix_timestamp: i64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("The amount must be more than zero")]
    ZeroAmount,
    #[msg("New deposits are paused by the pool's authority")]
    DepositsPaused,
    #[msg("New deposits are paused for the pool's health")]
    DepositsPausedForHealth,
    #[msg("The instruction before must be an Ed25519 attestation by one of the pool's attesters")]
    MissingAttestation,
    #[msg("The Ed25519 instruction isn't a single signature over its own data")]
    MalformedAttestation,
    #[msg("The attestation isn't signed by one of the pool's attesters")]
    UnknownAttester,
    #[msg("The attestation doesn't say what this instruction needs")]
    AttestationMismatch,
    #[msg("The attestation has expired")]
    AttestationExpired,
    #[msg("The attestation is older than the terms allow, or not newer than the last")]
    AttestationStale,
    #[msg("This would take the depositor's principal over the commitment maximum")]
    AboveCommitmentMax,
    #[msg("This would leave the depositor's principal under the commitment minimum")]
    BelowCommitmentMin,
    #[msg("The deposit was rejected")]
    DepositRejected,
    #[msg("The deposit is still in its lock-in")]
    DepositLocked,
    #[msg("More than what's left of the deposit and not already queued")]
    ExceedsUnlocked,
    #[msg("The request is no longer open")]
    RequestClosed,
    #[msg("The request's notice period hasn't passed")]
    NoticeNotElapsed,
    #[msg("Nothing can be paid without going below the reserve floor")]
    ReserveFloor,
    #[msg("Not allowed")]
    Unauthorized,
    #[msg("The terms are invalid")]
    InvalidTerms,
    #[msg("The terms would be laxer than the product floor")]
    TermsBelowFloor,
    #[msg("The terms can't take effect that soon")]
    TimelockTooShort,
    #[msg("No terms are pending")]
    NoPendingTerms,
    #[msg("The pending terms aren't effective yet")]
    TermsNotEffective,
    #[msg("The pool's extension program must be passed")]
    ExtensionMissing,
    #[msg("That isn't the pool's extension program")]
    WrongExtension,
    #[msg("An extension may only get write access to accounts it owns")]
    ExtensionAccountNotWritable,
    #[msg("Arithmetic overflow")]
    Overflow,
}
