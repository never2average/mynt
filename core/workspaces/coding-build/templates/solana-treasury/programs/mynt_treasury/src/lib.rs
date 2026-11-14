use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions as instructions_sysvar;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod attestation;

// A placeholder nobody holds a key for. Each app's treasury is deployed at the address Mynt reserved for it; the
// template's own build (and the hash in schemas/solana-treasury-template.json) is at this one.
declare_id!("DCw4DC1HrhApHAWMxNhrKxw7XGHWGHndAMqVFfp13bJz");

/// Mynt's treasury template. A liquidity pool's capital is held as USDC in a token account owned by the pool's PDA,
/// and every payment out goes to a depositor's own associated token account: the withdrawal queue (from its head,
/// after the notice period, never below the reserve floor, only from the deposit a request was made against once
/// it's unlocked), a parked request once its account is thawed, a deposit refused during its review window, and a
/// wind-down's surplus pro rata. The pool's authority (a Squads vault in production) can pause new deposits,
/// propose timelocked terms within the product floor's minima and maxima, remove an attester, refuse a deposit under
/// review, and propose a timelocked wind-down; it can never pause exits or take funds.
///
/// Patterns: the PDA-owned vault, two-step withdrawal with a cooldown, deposit capacity and split roles are Jito
/// Restaking's vault program's; the ed25519 approver attestations and the redemption queue with partial fills are
/// OnRe's onre-sol (see UPSTREAM.json).
#[program]
pub mod mynt_treasury {
    use super::*;

    /// Opens a pool: its terms and the product floor they must stay within are account state, not code. `cluster`
    /// is the cluster's genesis hash, which every attestation for this pool signs (the program can't read it, so
    /// Mynt's gate checks it against the cluster the pool lives on).
    pub fn initialize_pool(ctx: Context<InitializePool>, pool_id: u64, cluster: [u8; 32], terms: Terms, floor: ProductFloor, min_timelock_seconds: i64) -> Result<()> {
        validate_floor(&floor)?;
        validate_terms(&terms, &floor)?;
        require!(min_timelock_seconds > 0 && min_timelock_seconds >= terms.notice_seconds, TreasuryError::TimelockTooShort);
        require_keys_neq!(ctx.accounts.authority.key(), Pubkey::default(), TreasuryError::InvalidTerms);
        let pool = &mut ctx.accounts.pool;
        pool.creator = ctx.accounts.creator.key();
        pool.pool_id = pool_id;
        pool.cluster = cluster;
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
        pool.total_deposited = 0;
        pool.total_queued = 0;
        pool.total_parked = 0;
        pool.next_deposit_seq = 0;
        pool.next_request_seq = 0;
        pool.head_seq = 0;
        pool.wind_down_at = 0;
        pool.wind_down_started = false;
        pool.surplus = 0;
        pool.surplus_paid = 0;
        pool.deposited_at_wind_down = 0;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;
        emit!(PoolInitialized {
            pool: pool.key(),
            creator: pool.creator,
            authority: pool.authority,
            usdc_mint: pool.usdc_mint,
            vault: pool.vault,
            cluster,
            terms,
            floor,
            min_timelock_seconds,
        });
        Ok(())
    }

    /// A deposit from an allow-listed depositor: the instruction just before must be an Ed25519 verification of the
    /// pool's deposit approval for this depositor (at their position's current nonce) by one of the pool's attesters,
    /// not yet expired. Each deposit is its own record, with the lock-in and notice copied from the terms in force
    /// now; `max_lock_in_seconds` is what the depositor agreed to, so a terms change landing first can't surprise them.
    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, MakeDeposit<'info>>, amount: u64, approval_expiry: i64, max_lock_in_seconds: i64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let depositor = ctx.accounts.depositor.key();
        {
            let position = &mut ctx.accounts.position;
            if position.depositor == Pubkey::default() {
                position.pool = pool_key;
                position.depositor = depositor;
                position.bump = ctx.bumps.position;
            }
        }
        {
            let pool = &ctx.accounts.pool;
            require!(!winding_down(pool, now), TreasuryError::WindingDown);
            require!(!pool.sponsor_paused, TreasuryError::DepositsPaused);
            if pool.health_paused {
                require!(pool.terms.topups_when_health_paused, TreasuryError::DepositsPausedForHealth);
                require!(ctx.accounts.position.principal > 0, TreasuryError::TopUpsOnly);
            }
            require!(pool.terms.lock_in_seconds <= max_lock_in_seconds, TreasuryError::TermsChanged);
            require!(approval_expiry >= now, TreasuryError::AttestationExpired);
            let expected = deposit_approval_message(&pool.cluster, &pool_key, &depositor, ctx.accounts.position.nonce, approval_expiry);
            attestation::verify_attestations(&ctx.accounts.instructions.to_account_info(), &pool.terms.attesters, &expected, 1)?;
        }

        let principal = ctx.accounts.position.principal.checked_add(amount).ok_or(TreasuryError::Overflow)?;
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

        let position = &mut ctx.accounts.position;
        position.principal = principal;
        position.deposited = position.deposited.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        position.deposits = position.deposits.checked_add(1).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        let seq = pool.next_deposit_seq;
        let record = &mut ctx.accounts.deposit;
        record.pool = pool_key;
        record.depositor = depositor;
        record.seq = seq;
        record.amount = amount;
        record.remaining = amount;
        record.queued = 0;
        record.settled_at = now;
        record.review_until = now.checked_add(pool.floor.review_window_seconds).ok_or(TreasuryError::Overflow)?;
        record.lock_in_seconds = pool.terms.lock_in_seconds;
        record.unlock_at = now.checked_add(pool.terms.lock_in_seconds).ok_or(TreasuryError::Overflow)?;
        record.notice_seconds = pool.terms.notice_seconds;
        record.rejected = false;
        record.bump = ctx.bumps.deposit;
        pool.next_deposit_seq = seq.checked_add(1).ok_or(TreasuryError::Overflow)?;
        pool.total_principal = pool.total_principal.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        pool.total_deposited = pool.total_deposited.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        emit!(DepositMade {
            pool: pool_key,
            depositor,
            deposit: record.key(),
            seq,
            amount,
            settled_at: now,
            review_until: record.review_until,
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
            ctx.accounts.hook.to_account_info(),
            ctx.bumps.hook,
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

    /// Refuses a deposit still in its review window (the product floor's `review_window_seconds`): a refund of money
    /// the pool never accepted, to the depositor's own associated token account. It can't be requested against
    /// during the window, so nothing it pays was ever in the queue. The depositor's nonce moves on, so the attestation
    /// they deposited with can't be used again.
    pub fn reject_deposit(ctx: Context<RejectDeposit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let refund = ctx.accounts.deposit.remaining;
        require!(!winding_down(&ctx.accounts.pool, now), TreasuryError::WindingDown);
        require!(!ctx.accounts.deposit.rejected, TreasuryError::DepositRejected);
        require!(now < ctx.accounts.deposit.review_until, TreasuryError::ReviewWindowClosed);
        require!(ctx.accounts.deposit.queued == 0, TreasuryError::RequestOpen);
        require!(refund > 0, TreasuryError::ZeroAmount);
        pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.usdc_mint, &ctx.accounts.depositor_token, &ctx.accounts.pool, refund)?;
        let deposit = &mut ctx.accounts.deposit;
        deposit.remaining = 0;
        deposit.rejected = true;
        let position = &mut ctx.accounts.position;
        position.principal = position.principal.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        position.deposited = position.deposited.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        position.nonce = position.nonce.checked_add(1).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_principal = pool.total_principal.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        pool.total_deposited = pool.total_deposited.checked_sub(refund).ok_or(TreasuryError::Overflow)?;
        emit!(DepositRejected { pool: pool_key, depositor: deposit.depositor, deposit: deposit.key(), seq: deposit.seq, refunded: refund, nonce: position.nonce });
        Ok(())
    }

    /// Joins the withdrawal queue against one deposit, past its review window and unlocked (a wind-down lifts
    /// lock-ins): at most what's left of it less what's already queued, and at least the terms' minimum request
    /// unless it's all that's left. The notice is the shorter of the deposit's and the current terms', and must be no
    /// more than `max_notice_seconds`, what the depositor expects.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, amount: u64, max_notice_seconds: i64) -> Result<()> {
        require!(amount > 0, TreasuryError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let wind_down = winding_down(&ctx.accounts.pool, now);
        let (min_request, terms_notice) = (ctx.accounts.pool.terms.min_request, ctx.accounts.pool.terms.notice_seconds);
        let deposit = &mut ctx.accounts.deposit;
        require!(!deposit.rejected, TreasuryError::DepositRejected);
        require!(wind_down || now >= deposit.review_until, TreasuryError::InReview);
        require!(wind_down || now >= deposit.unlock_at, TreasuryError::DepositLocked);
        let free = deposit.remaining.checked_sub(deposit.queued).ok_or(TreasuryError::Overflow)?;
        require!(amount <= free, TreasuryError::ExceedsUnlocked);
        require!(amount >= min_request || amount == free, TreasuryError::BelowMinRequest);
        let notice = deposit.notice_seconds.min(terms_notice);
        require!(notice <= max_notice_seconds, TreasuryError::TermsChanged);
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
        request.payable_at = now.checked_add(notice).ok_or(TreasuryError::Overflow)?;
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

    /// The depositor withdraws an open or parked request; the queue skips it when it reaches the head.
    pub fn cancel_request(ctx: Context<CancelRequest>) -> Result<()> {
        let request = &mut ctx.accounts.request;
        require!(request.status == REQUEST_OPEN || request.status == REQUEST_PARKED, TreasuryError::RequestClosed);
        let left = request.remaining;
        let was_parked = request.status == REQUEST_PARKED;
        request.remaining = 0;
        request.status = REQUEST_CANCELLED;
        let deposit = &mut ctx.accounts.deposit;
        deposit.queued = deposit.queued.checked_sub(left).ok_or(TreasuryError::Overflow)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_queued = pool.total_queued.checked_sub(left).ok_or(TreasuryError::Overflow)?;
        if was_parked {
            pool.total_parked = pool.total_parked.checked_sub(left).ok_or(TreasuryError::Overflow)?;
        }
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
            return advance_head(&mut ctx.accounts.pool, pool_key);
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
            return advance_head(pool, pool_key);
        }
        require!(winding_down(&ctx.accounts.pool, now) || now >= ctx.accounts.deposit.unlock_at, TreasuryError::DepositLocked);
        require!(now >= ctx.accounts.request.payable_at, TreasuryError::NoticeNotElapsed);

        let floor = reserve_floor(&ctx.accounts.pool, now);
        let available = ctx.accounts.vault.amount.saturating_sub(floor);
        let pay = ctx.accounts.request.remaining.min(available).min(ctx.accounts.deposit.remaining);
        require!(pay > 0, TreasuryError::ReserveFloor);
        pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.usdc_mint, &ctx.accounts.requester_token, &ctx.accounts.pool, pay)?;
        record_payment(&mut ctx.accounts.pool, &mut ctx.accounts.request, &mut ctx.accounts.deposit, &mut ctx.accounts.position, pay)?;
        let remaining = ctx.accounts.request.remaining;
        emit!(WithdrawalPaid {
            pool: pool_key,
            depositor,
            request: ctx.accounts.request.key(),
            seq,
            amount: pay,
            remaining,
            partial: remaining > 0,
            parked: false,
            reserve_floor: floor,
            vault_after: ctx.accounts.vault.amount - pay,
        });
        if remaining == 0 {
            ctx.accounts.request.status = REQUEST_PAID;
            advance_head(&mut ctx.accounts.pool, pool_key)?;
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
                ctx.accounts.hook.to_account_info(),
                ctx.bumps.hook,
                ctx.accounts.pool.to_account_info(),
                ctx.accounts.request.to_account_info(),
                ctx.remaining_accounts,
                HookArgs { kind: HOOK_WITHDRAWAL_PAID, pool: pool_key, depositor, record: ctx.accounts.request.key(), amount: pay, seq },
            )?;
            emit!(ExtensionHook { pool: pool_key, program: extension, kind: HOOK_WITHDRAWAL_PAID, called });
        }
        Ok(())
    }

    /// Permissionless: when the head request's account is frozen (the mint can freeze it, and a frozen account can't
    /// be paid), the request is parked, keeping its claim and what's queued against its deposit, and the queue moves
    /// on so one frozen account can't hold up everyone behind it.
    pub fn park_head(ctx: Context<ParkHead>) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        require!(ctx.accounts.request.status == REQUEST_OPEN, TreasuryError::RequestClosed);
        require!(ctx.accounts.requester_token.is_frozen(), TreasuryError::NotFrozen);
        let request = &mut ctx.accounts.request;
        request.status = REQUEST_PARKED;
        let pool = &mut ctx.accounts.pool;
        pool.total_parked = pool.total_parked.checked_add(request.remaining).ok_or(TreasuryError::Overflow)?;
        emit!(RequestParked { pool: pool_key, depositor: request.depositor, request: request.key(), seq: request.seq, amount: request.remaining });
        advance_head(pool, pool_key)
    }

    /// Permissionless: pays a parked request once its account is no longer frozen, under the same checks as the
    /// queue (unlocked deposit, notice passed, never below the reserve floor). It was ahead of everything still queued.
    pub fn claim_parked(ctx: Context<ClaimParked>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        require!(ctx.accounts.request.status == REQUEST_PARKED, TreasuryError::NotParked);
        require!(!ctx.accounts.deposit.rejected, TreasuryError::DepositRejected);
        require!(winding_down(&ctx.accounts.pool, now) || now >= ctx.accounts.deposit.unlock_at, TreasuryError::DepositLocked);
        require!(now >= ctx.accounts.request.payable_at, TreasuryError::NoticeNotElapsed);
        let floor = reserve_floor(&ctx.accounts.pool, now);
        let pay = ctx.accounts.request.remaining.min(ctx.accounts.vault.amount.saturating_sub(floor)).min(ctx.accounts.deposit.remaining);
        require!(pay > 0, TreasuryError::ReserveFloor);
        pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.usdc_mint, &ctx.accounts.requester_token, &ctx.accounts.pool, pay)?;
        record_payment(&mut ctx.accounts.pool, &mut ctx.accounts.request, &mut ctx.accounts.deposit, &mut ctx.accounts.position, pay)?;
        let pool = &mut ctx.accounts.pool;
        pool.total_parked = pool.total_parked.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
        let request = &mut ctx.accounts.request;
        if request.remaining == 0 {
            request.status = REQUEST_PAID;
        }
        emit!(WithdrawalPaid {
            pool: pool_key,
            depositor: request.depositor,
            request: request.key(),
            seq: request.seq,
            amount: pay,
            remaining: request.remaining,
            partial: request.remaining > 0,
            parked: true,
            reserve_floor: floor,
            vault_after: ctx.accounts.vault.amount - pay,
        });
        Ok(())
    }

    /// The authority pauses or resumes new deposits. Exits have no pause.
    pub fn set_sponsor_pause(ctx: Context<AuthorityOnly>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.sponsor_paused = paused;
        emit!(PauseChanged { pool: pool.key(), sponsor_paused: pool.sponsor_paused, health_paused: pool.health_paused, by: ctx.accounts.authority.key() });
        Ok(())
    }

    /// The authority or the pool's health authority pauses deposits for the pool's health. Existing depositors may
    /// still top up while health-paused if the terms say so. Exits have no pause.
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

    /// Removes an attester at once, from the terms and from any pending terms: it only ever tightens who can admit
    /// depositors or state obligations, so it needs no timelock.
    pub fn remove_attester(ctx: Context<AuthorityOnly>, attester: Pubkey) -> Result<()> {
        require_keys_neq!(attester, Pubkey::default(), TreasuryError::InvalidTerms);
        let pool_key = ctx.accounts.pool.key();
        let pool: &mut Pool = &mut ctx.accounts.pool;
        let mut found = false;
        for slot in pool.terms.attesters.iter_mut().chain(pool.pending_terms.attesters.iter_mut()) {
            if *slot == attester {
                *slot = Pubkey::default();
                found = true;
            }
        }
        require!(found, TreasuryError::UnknownAttester);
        emit!(AttesterRemoved { pool: pool_key, attester });
        Ok(())
    }

    /// Proposes new terms within the product floor. They take effect no sooner than the pool's timelock and the
    /// notice in force, so anyone who dislikes them can be out first; terms that raise the reserve or the minimum
    /// request (which bind deposits already made) wait at least the floor's longest lock-in plus its longest notice.
    /// Lock-in and notice bind only deposits made after the change.
    pub fn propose_terms(ctx: Context<AuthorityOnly>, terms: Terms, effective_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        validate_terms(&terms, &pool.floor)?;
        let mut wait = pool.min_timelock_seconds.max(pool.terms.notice_seconds);
        if terms.min_reserve > pool.terms.min_reserve || terms.min_reserve_bps > pool.terms.min_reserve_bps || terms.min_request > pool.terms.min_request {
            let exits = pool.floor.max_lock_in_seconds.checked_add(pool.floor.max_notice_seconds).ok_or(TreasuryError::Overflow)?;
            wait = wait.max(exits);
        }
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

    /// Permissionless, once proposed terms are effective. Deposits already made keep their own lock-in and notice,
    /// and requests already made their payable time.
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

    /// Records the obligations figure the reserve's bps part is measured against: Ed25519 attestations newer than
    /// the last and no older than the terms' maximum staleness. A figure that rises needs both attesters (the two
    /// instructions just before); one that falls or holds needs one.
    pub fn attest_obligations(ctx: Context<AttestObligations>, obligations: u64, as_of: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(as_of <= now, TreasuryError::AttestationExpired);
        require!(now.checked_sub(as_of).ok_or(TreasuryError::Overflow)? <= pool.terms.obligations_max_staleness, TreasuryError::AttestationStale);
        require!(as_of > pool.obligations_as_of, TreasuryError::AttestationStale);
        let expected = obligations_message(&pool.cluster, &pool_key, obligations, as_of);
        let count = if obligations > pool.obligations { 2 } else { 1 };
        let signers = attestation::verify_attestations(&ctx.accounts.instructions.to_account_info(), &pool.terms.attesters, &expected, count)?;
        pool.obligations = obligations;
        pool.obligations_as_of = as_of;
        emit!(ObligationsAttested { pool: pool_key, obligations, as_of, attester: signers[0], attesters: signers.len() as u8, reserve_floor: reserve_floor(pool, now) });
        Ok(())
    }

    /// The authority proposes winding the pool down, no sooner than its timelock and notice. From then on deposits
    /// are closed, the reserve floor is zero and lock-ins no longer hold, so the queue can pay everyone out.
    pub fn propose_wind_down(ctx: Context<AuthorityOnly>, effective_at: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(pool.wind_down_at == 0, TreasuryError::WindingDown);
        let wait = pool.min_timelock_seconds.max(pool.terms.notice_seconds);
        require!(effective_at >= now.checked_add(wait).ok_or(TreasuryError::Overflow)?, TreasuryError::TimelockTooShort);
        pool.wind_down_at = effective_at;
        emit!(WindDownProposed { pool: pool.key(), effective_at });
        Ok(())
    }

    /// The authority withdraws a wind-down that hasn't taken effect.
    pub fn cancel_wind_down(ctx: Context<AuthorityOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(pool.wind_down_at != 0 && now < pool.wind_down_at, TreasuryError::WindingDown);
        pool.wind_down_at = 0;
        emit!(WindDownCancelled { pool: pool.key() });
        Ok(())
    }

    /// Permissionless, once a wind-down has taken effect: records the surplus (what the vault holds above all
    /// principal still owed) and the deposits it's shared over. Deposits and rejections are closed by then, so the
    /// shares can't change.
    pub fn start_wind_down(ctx: Context<StartWindDown>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pool = &mut ctx.accounts.pool;
        require!(winding_down(pool, now), TreasuryError::NotWindingDown);
        require!(!pool.wind_down_started, TreasuryError::WindingDown);
        pool.wind_down_started = true;
        pool.surplus = ctx.accounts.vault.amount.saturating_sub(pool.total_principal);
        pool.deposited_at_wind_down = pool.total_deposited;
        emit!(WindDownStarted { pool: pool.key(), surplus: pool.surplus, deposited: pool.deposited_at_wind_down, principal: pool.total_principal });
        Ok(())
    }

    /// Permissionless: pays a depositor their pro rata share of the wind-down's surplus (by what they deposited and
    /// wasn't refused), once, to their own associated token account. Never out of principal still owed.
    pub fn claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        require!(ctx.accounts.pool.wind_down_started, TreasuryError::NotWindingDown);
        require!(!ctx.accounts.position.surplus_claimed, TreasuryError::SurplusClaimed);
        let (surplus, deposited) = (ctx.accounts.pool.surplus, ctx.accounts.pool.deposited_at_wind_down);
        let share = if deposited == 0 { 0 } else { (surplus as u128 * ctx.accounts.position.deposited as u128 / deposited as u128) as u64 };
        let owed = ctx.accounts.pool.total_principal;
        require!(ctx.accounts.vault.amount.saturating_sub(owed) >= share, TreasuryError::ReserveFloor);
        if share > 0 {
            pay_from_vault(&ctx.accounts.token_program, &ctx.accounts.vault, &ctx.accounts.usdc_mint, &ctx.accounts.depositor_token, &ctx.accounts.pool, share)?;
        }
        ctx.accounts.position.surplus_claimed = true;
        let pool = &mut ctx.accounts.pool;
        pool.surplus_paid = pool.surplus_paid.checked_add(share).ok_or(TreasuryError::Overflow)?;
        emit!(SurplusClaimed { pool: pool_key, depositor: ctx.accounts.position.depositor, amount: share });
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
            total_parked: pool.total_parked,
            reserve_floor: reserve_floor(pool, clock.unix_timestamp),
            obligations: pool.obligations,
            obligations_as_of: pool.obligations_as_of,
            head_seq: pool.head_seq,
            next_request_seq: pool.next_request_seq,
            next_deposit_seq: pool.next_deposit_seq,
            sponsor_paused: pool.sponsor_paused,
            health_paused: pool.health_paused,
            winding_down: winding_down(pool, clock.unix_timestamp),
            slot: clock.slot,
            unix_timestamp: clock.unix_timestamp,
        });
        Ok(())
    }
}

// ---- rules ----

pub const MAX_BPS: u16 = 10_000;
pub const DEPOSIT_APPROVAL_DOMAIN: [u8; 8] = *b"MYNTDEP2";
pub const OBLIGATIONS_DOMAIN: [u8; 8] = *b"MYNTOBL2";
/// sha256("global:on_treasury_event")[..8]: an Anchor extension handles the hook as `on_treasury_event`.
pub const EXTENSION_HOOK_DISCRIMINATOR: [u8; 8] = [225, 98, 18, 23, 251, 52, 176, 175];
pub const HOOK_DEPOSIT: u8 = 0;
pub const HOOK_WITHDRAWAL_PAID: u8 = 1;
pub const REQUEST_OPEN: u8 = 0;
pub const REQUEST_PAID: u8 = 1;
pub const REQUEST_CANCELLED: u8 = 2;
pub const REQUEST_VOIDED: u8 = 3;
pub const REQUEST_PARKED: u8 = 4;

/// What an attester signs to allow a depositor into a pool, at their position's nonce, until `expiry`.
pub fn deposit_approval_message(cluster: &[u8; 32], pool: &Pubkey, depositor: &Pubkey, nonce: u64, expiry: i64) -> Vec<u8> {
    let mut m = Vec::with_capacity(152);
    m.extend_from_slice(&DEPOSIT_APPROVAL_DOMAIN);
    m.extend_from_slice(crate::ID.as_ref());
    m.extend_from_slice(cluster);
    m.extend_from_slice(pool.as_ref());
    m.extend_from_slice(depositor.as_ref());
    m.extend_from_slice(&nonce.to_le_bytes());
    m.extend_from_slice(&expiry.to_le_bytes());
    m
}

/// What an attester signs to state a pool's obligations figure as of a time.
pub fn obligations_message(cluster: &[u8; 32], pool: &Pubkey, obligations: u64, as_of: i64) -> Vec<u8> {
    let mut m = Vec::with_capacity(120);
    m.extend_from_slice(&OBLIGATIONS_DOMAIN);
    m.extend_from_slice(crate::ID.as_ref());
    m.extend_from_slice(cluster);
    m.extend_from_slice(pool.as_ref());
    m.extend_from_slice(&obligations.to_le_bytes());
    m.extend_from_slice(&as_of.to_le_bytes());
    m
}

pub fn winding_down(pool: &Pool, now: i64) -> bool {
    pool.wind_down_at != 0 && now >= pool.wind_down_at
}

/// The least the vault must keep: the fixed floor or the bps part of the last attested obligations (rounded up),
/// whichever is more, but never more than the floor's `max_reserve_bps` of the principal still owed, so no figure
/// can hold every exit shut. Zero in a wind-down. A stale obligations figure isn't dropped; a newer one replaces it.
pub fn reserve_floor(pool: &Pool, now: i64) -> u64 {
    if winding_down(pool, now) {
        return 0;
    }
    let bps = (pool.obligations as u128 * pool.terms.min_reserve_bps as u128).div_ceil(MAX_BPS as u128);
    let floor = (pool.terms.min_reserve as u128).max(bps);
    let cap = pool.total_principal as u128 * pool.floor.max_reserve_bps as u128 / MAX_BPS as u128;
    floor.min(cap) as u64
}

fn validate_floor(f: &ProductFloor) -> Result<()> {
    require!(f.min_lock_in_seconds >= 0 && f.max_lock_in_seconds >= f.min_lock_in_seconds, TreasuryError::InvalidTerms);
    require!(f.min_notice_seconds >= 0 && f.max_notice_seconds >= f.min_notice_seconds, TreasuryError::InvalidTerms);
    require!(f.max_min_reserve >= f.min_reserve, TreasuryError::InvalidTerms);
    require!(f.max_reserve_bps <= MAX_BPS && f.min_reserve_bps <= f.max_reserve_bps, TreasuryError::InvalidTerms);
    require!(f.max_obligations_staleness > 0 && f.review_window_seconds >= 0, TreasuryError::InvalidTerms);
    require!(f.max_commitment > 0 && f.min_commitment <= f.max_commitment, TreasuryError::InvalidTerms);
    Ok(())
}

/// Terms stay within the product floor both ways: never laxer for the pool (no shorter lock-in or notice, no lower
/// reserve, no staler obligations figure, no bigger commitment, top-ups during a health pause only if allowed) and
/// never tighter for depositors than its maxima (no longer lock-in or notice, no higher reserve).
fn validate_terms(t: &Terms, f: &ProductFloor) -> Result<()> {
    require!(t.min_reserve_bps <= MAX_BPS && t.obligations_max_staleness > 0, TreasuryError::InvalidTerms);
    require!(t.commitment_max > 0 && t.commitment_min <= t.commitment_max && t.min_request <= t.commitment_max, TreasuryError::InvalidTerms);
    require!(t.attesters.iter().any(|a| *a != Pubkey::default()), TreasuryError::InvalidTerms);
    require!(t.extension_program != crate::ID, TreasuryError::InvalidTerms);
    require!(t.lock_in_seconds >= f.min_lock_in_seconds, TreasuryError::TermsBelowFloor);
    require!(t.notice_seconds >= f.min_notice_seconds, TreasuryError::TermsBelowFloor);
    require!(t.min_reserve >= f.min_reserve, TreasuryError::TermsBelowFloor);
    require!(t.min_reserve_bps >= f.min_reserve_bps, TreasuryError::TermsBelowFloor);
    require!(t.obligations_max_staleness <= f.max_obligations_staleness, TreasuryError::TermsBelowFloor);
    require!(t.commitment_min >= f.min_commitment, TreasuryError::TermsBelowFloor);
    require!(t.commitment_max <= f.max_commitment, TreasuryError::TermsBelowFloor);
    require!(!t.topups_when_health_paused || f.topups_when_health_paused_allowed, TreasuryError::TermsBelowFloor);
    require!(t.lock_in_seconds <= f.max_lock_in_seconds, TreasuryError::TermsAboveMaximum);
    require!(t.notice_seconds <= f.max_notice_seconds, TreasuryError::TermsAboveMaximum);
    require!(t.min_reserve <= f.max_min_reserve, TreasuryError::TermsAboveMaximum);
    require!(t.min_reserve_bps <= f.max_reserve_bps, TreasuryError::TermsAboveMaximum);
    Ok(())
}

fn advance_head(pool: &mut Pool, key: Pubkey) -> Result<()> {
    pool.head_seq = pool.head_seq.checked_add(1).ok_or(TreasuryError::Overflow)?;
    emit!(QueueAdvanced { pool: key, head_seq: pool.head_seq });
    Ok(())
}

/// The pool's PDA signs a transfer out of the vault. Callers only ever pass a depositor's own associated token account.
fn pay_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    pool: &Account<'info, Pool>,
    amount: u64,
) -> Result<()> {
    let id = pool.pool_id.to_le_bytes();
    let bump = [pool.bump];
    let seeds: &[&[u8]] = &[b"pool", pool.creator.as_ref(), &id, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked { from: vault.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: pool.to_account_info() },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn record_payment(pool: &mut Pool, request: &mut WithdrawalRequest, deposit: &mut DepositRecord, position: &mut Position, pay: u64) -> Result<()> {
    request.remaining = request.remaining.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
    request.paid = request.paid.checked_add(pay).ok_or(TreasuryError::Overflow)?;
    deposit.remaining = deposit.remaining.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
    deposit.queued = deposit.queued.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
    position.principal = position.principal.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
    pool.total_principal = pool.total_principal.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
    pool.total_queued = pool.total_queued.checked_sub(pay).ok_or(TreasuryError::Overflow)?;
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

/// Calls the pool's extension, if it has one. The only signer is the pool's hook PDA (`["hook", pool]`, which owns
/// nothing), so the extension can tell the call came from this treasury; the treasury never signs as the pool (the
/// vault's owner). The pool and the record go read-only; the caller's extra accounts are forwarded never as signers,
/// and writable only when the extension itself owns them (anything else goes read-only).
#[allow(clippy::too_many_arguments)]
fn run_extension<'info>(
    extension: Pubkey,
    passed: Option<&UncheckedAccount<'info>>,
    required: bool,
    hook: AccountInfo<'info>,
    hook_bump: u8,
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
    let pool_key = pool.key();
    let mut metas = vec![AccountMeta::new_readonly(hook.key(), true), AccountMeta::new_readonly(pool_key, false), AccountMeta::new_readonly(record.key(), false)];
    let mut infos = vec![hook, pool, record];
    for a in forwarded {
        // Writable in this transaction (an account the treasury itself writes, like the vault, is) is not enough:
        // only an account the extension owns is passed on writable.
        if a.is_writable && *a.owner == extension {
            metas.push(AccountMeta::new(a.key(), false));
        } else {
            metas.push(AccountMeta::new_readonly(a.key(), false));
        }
        infos.push(a.clone());
    }
    infos.push(program.to_account_info());
    let mut data = EXTENSION_HOOK_DISCRIMINATOR.to_vec();
    args.serialize(&mut data)?;
    let bump = [hook_bump];
    let seeds: &[&[u8]] = &[b"hook", pool_key.as_ref(), &bump];
    invoke_signed(&Instruction { program_id: extension, accounts: metas, data }, &infos, &[seeds])?;
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
    /// CHECK: the pool's hook PDA: owns nothing, signs only calls to the extension.
    #[account(seeds = [b"hook", pool.key().as_ref()], bump)]
    pub hook: UncheckedAccount<'info>,
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
    /// CHECK: the pool's hook PDA: owns nothing, signs only calls to the extension.
    #[account(seeds = [b"hook", pool.key().as_ref()], bump)]
    pub hook: UncheckedAccount<'info>,
    /// CHECK: the pool's extension program, or left out (checked in run_extension).
    pub extension_program: Option<UncheckedAccount<'info>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ParkHead<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, seeds = [b"request", pool.key().as_ref(), &pool.head_seq.to_le_bytes()], bump = request.bump)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(address = get_associated_token_address(&request.depositor, &pool.usdc_mint))]
    pub requester_token: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct ClaimParked<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, has_one = deposit, seeds = [b"request", pool.key().as_ref(), &request.seq.to_le_bytes()], bump = request.bump)]
    pub request: Box<Account<'info, WithdrawalRequest>>,
    #[account(mut, has_one = pool)]
    pub deposit: Box<Account<'info, DepositRecord>>,
    #[account(mut, seeds = [b"position", pool.key().as_ref(), request.depositor.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = get_associated_token_address(&request.depositor, &pool.usdc_mint))]
    pub requester_token: Box<Account<'info, TokenAccount>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
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
pub struct StartWindDown<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct ClaimSurplus<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, has_one = pool, seeds = [b"position", pool.key().as_ref(), position.depositor.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// Only ever the depositor's own associated token account.
    #[account(mut, address = get_associated_token_address(&position.depositor, &pool.usdc_mint))]
    pub depositor_token: Box<Account<'info, TokenAccount>>,
    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    #[account(seeds = [b"pool", pool.creator.as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
}

// ---- state ----

/// A pool's terms: config, not code. Changed only by propose_terms → apply_terms (or remove_attester, which only
/// tightens), always within the product floor.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Terms {
    /// Each deposit is locked this long from when it settles (copied onto the deposit).
    pub lock_in_seconds: i64,
    /// A withdrawal request is payable this long after it's made (copied onto each deposit; the shorter applies).
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
    /// The smallest withdrawal request, unless it's all that's left of the deposit.
    pub min_request: u64,
    /// Whether existing depositors may top up while the pool is paused for health.
    pub topups_when_health_paused: bool,
    /// An app's own reviewed program called on deposits and payments, or the default key for none.
    pub extension_program: Pubkey,
    /// The keys whose Ed25519 attestations allow depositors and state obligations (the default key for an unused slot).
    pub attesters: [Pubkey; 2],
    /// Who besides the authority may pause deposits for health (the default key for nobody).
    pub health_authority: Pubkey,
}

/// What the product requires of every terms the pool ever has, both ways. Recorded at initialisation; nothing
/// changes it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct ProductFloor {
    pub min_lock_in_seconds: i64,
    pub max_lock_in_seconds: i64,
    pub min_notice_seconds: i64,
    pub max_notice_seconds: i64,
    pub min_reserve: u64,
    pub max_min_reserve: u64,
    pub min_reserve_bps: u16,
    /// Also caps the reserve floor at this share of the principal still owed.
    pub max_reserve_bps: u16,
    pub max_obligations_staleness: i64,
    pub min_commitment: u64,
    pub max_commitment: u64,
    pub topups_when_health_paused_allowed: bool,
    /// How long after it settles a deposit may still be refused (and can't be requested against).
    pub review_window_seconds: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub creator: Pubkey,
    pub pool_id: u64,
    /// The cluster's genesis hash, signed into every attestation.
    pub cluster: [u8; 32],
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
    /// Everything deposited and not refused (what a wind-down's surplus is shared over).
    pub total_deposited: u64,
    /// What's left of every open or parked withdrawal request.
    pub total_queued: u64,
    /// What's left of every parked request.
    pub total_parked: u64,
    pub next_deposit_seq: u64,
    pub next_request_seq: u64,
    /// The sequence number of the request at the head of the queue (== next_request_seq when it's empty).
    pub head_seq: u64,
    /// When a proposed wind-down takes effect (0: none).
    pub wind_down_at: i64,
    pub wind_down_started: bool,
    pub surplus: u64,
    pub surplus_paid: u64,
    pub deposited_at_wind_down: u64,
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
    /// Everything deposited and not refused.
    pub deposited: u64,
    pub deposits: u64,
    /// Signed into the deposit approval; a refused deposit moves it on.
    pub nonce: u64,
    pub surplus_claimed: bool,
    pub bump: u8,
}

/// One deposit, with its own review window, lock-in and notice.
#[account]
#[derive(InitSpace)]
pub struct DepositRecord {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub seq: u64,
    pub amount: u64,
    /// Not yet paid out or refunded.
    pub remaining: u64,
    /// In open or parked withdrawal requests against this deposit.
    pub queued: u64,
    pub settled_at: i64,
    pub review_until: i64,
    pub lock_in_seconds: i64,
    pub unlock_at: i64,
    pub notice_seconds: i64,
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
    pub cluster: [u8; 32],
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
    pub review_until: i64,
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
    pub nonce: u64,
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
    pub parked: bool,
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
pub struct RequestParked {
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
pub struct AttesterRemoved {
    pub pool: Pubkey,
    pub attester: Pubkey,
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
    pub attesters: u8,
    pub reserve_floor: u64,
}

#[event]
pub struct WindDownProposed {
    pub pool: Pubkey,
    pub effective_at: i64,
}

#[event]
pub struct WindDownCancelled {
    pub pool: Pubkey,
}

#[event]
pub struct WindDownStarted {
    pub pool: Pubkey,
    pub surplus: u64,
    pub deposited: u64,
    pub principal: u64,
}

#[event]
pub struct SurplusClaimed {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
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
    pub total_parked: u64,
    pub reserve_floor: u64,
    pub obligations: u64,
    pub obligations_as_of: i64,
    pub head_seq: u64,
    pub next_request_seq: u64,
    pub next_deposit_seq: u64,
    pub sponsor_paused: bool,
    pub health_paused: bool,
    pub winding_down: bool,
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
    #[msg("While the pool is paused for health, only existing depositors may top up")]
    TopUpsOnly,
    #[msg("The instruction before must be an Ed25519 attestation by one of the pool's attesters")]
    MissingAttestation,
    #[msg("The Ed25519 instruction isn't a single signature over its own data")]
    MalformedAttestation,
    #[msg("The attestation isn't signed by one of the pool's attesters")]
    UnknownAttester,
    #[msg("The attestation doesn't say what this instruction needs")]
    AttestationMismatch,
    #[msg("A rising obligations figure needs both attesters")]
    NeedsTwoAttesters,
    #[msg("The attestation has expired")]
    AttestationExpired,
    #[msg("The attestation is older than the terms allow, or not newer than the last")]
    AttestationStale,
    #[msg("The terms are stricter than the depositor agreed to")]
    TermsChanged,
    #[msg("This would take the depositor's principal over the commitment maximum")]
    AboveCommitmentMax,
    #[msg("This would leave the depositor's principal under the commitment minimum")]
    BelowCommitmentMin,
    #[msg("The deposit was rejected")]
    DepositRejected,
    #[msg("The deposit's review window has closed")]
    ReviewWindowClosed,
    #[msg("The deposit is still in its review window")]
    InReview,
    #[msg("A withdrawal request is open against the deposit")]
    RequestOpen,
    #[msg("The deposit is still in its lock-in")]
    DepositLocked,
    #[msg("More than what's left of the deposit and not already queued")]
    ExceedsUnlocked,
    #[msg("Less than the minimum request")]
    BelowMinRequest,
    #[msg("The request is no longer open")]
    RequestClosed,
    #[msg("The requester's token account isn't frozen")]
    NotFrozen,
    #[msg("The request isn't parked")]
    NotParked,
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
    #[msg("The terms would be stricter than the product floor's maximum")]
    TermsAboveMaximum,
    #[msg("The terms can't take effect that soon")]
    TimelockTooShort,
    #[msg("No terms are pending")]
    NoPendingTerms,
    #[msg("The pending terms aren't effective yet")]
    TermsNotEffective,
    #[msg("The pool is winding down, or a wind-down is already proposed or started")]
    WindingDown,
    #[msg("The pool isn't winding down")]
    NotWindingDown,
    #[msg("The surplus share was already claimed")]
    SurplusClaimed,
    #[msg("The pool's extension program must be passed")]
    ExtensionMissing,
    #[msg("That isn't the pool's extension program")]
    WrongExtension,
    #[msg("Arithmetic overflow")]
    Overflow,
}
