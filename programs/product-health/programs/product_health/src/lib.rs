use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

// A placeholder nobody holds a key for: scripts/product-health-deploy.sh writes the real address into a copy of the
// program before it builds, and CI builds this file as it stands. It can never be deployed under this address.
declare_id!("GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz");

/// Mynt's tamper-evident record of each product's financial health. For every product (a `subject`: a keyed hash Mynt
/// computes, so its id can't be guessed from it) one head account holds the newest sequence number, the fingerprint of
/// the snapshot (a sha256; the numbers themselves never come on chain), its period, where its numbers came from, a
/// per-product commitment to the licence provider's co-signature, and a hash chain over every earlier record. Each
/// record emits an event.
///
/// The chain makes a change to a past record visible to anyone holding the records. It doesn't stop the program itself
/// being replaced: whoever holds the upgrade authority can change it until it's frozen or put behind a timelock.
///
/// The program can't check the co-signature: `partner_signed` says only that the publisher supplied a non-zero
/// commitment. An entitled reader gets the key and signature from get_product_health and checks them against this
/// commitment itself (scripts/product-health-verify.mjs). An on-chain Ed25519 check would have to publish the partner's
/// key and link its products.
///
/// It holds nothing and moves nothing: no token program is ever called, and no account here pays anyone. The publisher
/// is whoever the program's own upgrade authority installed at initialisation; there's no hard-coded key.
#[program]
pub mod product_health {
    use super::*;

    /// One time: the program's upgrade authority names the publisher, which signs to show it holds the key.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.publisher = ctx.accounts.publisher.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Starts a product's record, before its first snapshot.
    pub fn open_subject(ctx: Context<OpenSubject>, subject: [u8; 32]) -> Result<()> {
        let head = &mut ctx.accounts.head;
        head.subject = subject;
        head.bump = ctx.bumps.head;
        Ok(())
    }

    /// One snapshot. Sequence numbers are gapless: the only one accepted is the next.
    #[allow(clippy::too_many_arguments)]
    pub fn record_snapshot(
        ctx: Context<Record>,
        subject: [u8; 32],
        sequence: u64,
        fingerprint: [u8; 32],
        period_start: i64,
        period_end: i64,
        source: u8,
        partner_commitment: [u8; 32],
    ) -> Result<()> {
        require!(fingerprint != [0u8; 32], HealthError::EmptyFingerprint);
        require!(source <= SOURCE_PARTNER, HealthError::UnknownSource);
        let publisher = ctx.accounts.publisher.key();
        advance(&mut ctx.accounts.head, Entry { subject, sequence, fingerprint, period_start, period_end, kind: KIND_SNAPSHOT, source, partner_commitment, reason: 0, publisher })
    }

    /// A period with no snapshot on chain: it takes its sequence number too, so a gap is recorded rather than hidden.
    pub fn record_missed(ctx: Context<Record>, subject: [u8; 32], sequence: u64, period_start: i64, period_end: i64, reason: u8) -> Result<()> {
        let publisher = ctx.accounts.publisher.key();
        advance(&mut ctx.accounts.head, Entry { subject, sequence, fingerprint: [0u8; 32], period_start, period_end, kind: KIND_MISSED, source: SOURCE_NONE, partner_commitment: [0u8; 32], reason, publisher })
    }
}

pub const SOURCE_NONE: u8 = 0;
pub const SOURCE_SANDBOX: u8 = 1;
pub const SOURCE_PARTNER: u8 = 2;
pub const KIND_SNAPSHOT: u8 = 0;
pub const KIND_MISSED: u8 = 1;
/// A period may end at most this far (seconds) past the cluster's clock.
pub const MAX_CLOCK_SKEW: i64 = 300;

struct Entry {
    subject: [u8; 32],
    sequence: u64,
    fingerprint: [u8; 32],
    period_start: i64,
    period_end: i64,
    kind: u8,
    source: u8,
    partner_commitment: [u8; 32],
    reason: u8,
    publisher: Pubkey,
}

fn advance(head: &mut Head, e: Entry) -> Result<()> {
    let next = head.sequence.checked_add(1).ok_or(HealthError::SequenceOverflow)?;
    require!(e.sequence == next, HealthError::SequenceNotNext);
    require!(e.subject == head.subject, HealthError::WrongSubject);
    require!(e.period_end > e.period_start, HealthError::EmptyPeriod);
    if head.sequence > 0 {
        require!(e.period_start == head.period_end, HealthError::PeriodNotContiguous);
    }
    let latest = Clock::get()?.unix_timestamp.checked_add(MAX_CLOCK_SKEW).ok_or(HealthError::PeriodInFuture)?;
    require!(e.period_end <= latest, HealthError::PeriodInFuture);
    let sequence_bytes = e.sequence.to_le_bytes();
    let start_bytes = e.period_start.to_le_bytes();
    let end_bytes = e.period_end.to_le_bytes();
    let kind_bytes = [e.kind];
    let source_bytes = [e.source];
    let chain = hashv(&[
        &head.chain[..],
        &e.subject[..],
        &sequence_bytes[..],
        &e.fingerprint[..],
        &start_bytes[..],
        &end_bytes[..],
        &kind_bytes[..],
        &source_bytes[..],
        &e.partner_commitment[..],
    ])
    .to_bytes();
    let partner_signed = e.partner_commitment != [0u8; 32];
    head.sequence = e.sequence;
    head.fingerprint = e.fingerprint;
    head.period_start = e.period_start;
    head.period_end = e.period_end;
    head.kind = e.kind;
    head.source = e.source;
    head.partner_signed = partner_signed;
    head.partner_commitment = e.partner_commitment;
    head.chain = chain;
    head.mynt_signer = e.publisher;
    emit!(SnapshotRecorded {
        subject: e.subject,
        sequence: e.sequence,
        kind: e.kind,
        fingerprint: e.fingerprint,
        period_start: e.period_start,
        period_end: e.period_end,
        source: e.source,
        partner_signed,
        partner_commitment: e.partner_commitment,
        reason: e.reason,
        chain,
        publisher: e.publisher,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = publisher, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub publisher: Signer<'info>,
    pub upgrade_authority: Signer<'info>,
    #[account(constraint = this_program.programdata_address()? == Some(program_data.key()) @ HealthError::WrongProgramData)]
    pub this_program: Program<'info, crate::program::ProductHealth>,
    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ HealthError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: [u8; 32])]
pub struct OpenSubject<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = publisher @ HealthError::NotPublisher)]
    pub config: Account<'info, Config>,
    #[account(init, payer = publisher, space = 8 + Head::INIT_SPACE, seeds = [b"head", subject.as_ref()], bump)]
    pub head: Account<'info, Head>,
    #[account(mut)]
    pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: [u8; 32])]
pub struct Record<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = publisher @ HealthError::NotPublisher)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"head", subject.as_ref()], bump = head.bump)]
    pub head: Account<'info, Head>,
    pub publisher: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub publisher: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Head {
    pub subject: [u8; 32],
    pub sequence: u64,
    pub fingerprint: [u8; 32],
    pub period_start: i64,
    pub period_end: i64,
    pub kind: u8,
    pub source: u8,
    pub partner_signed: bool,
    pub partner_commitment: [u8; 32],
    pub chain: [u8; 32],
    pub mynt_signer: Pubkey,
    pub bump: u8,
}

#[event]
pub struct SnapshotRecorded {
    pub subject: [u8; 32],
    pub sequence: u64,
    pub kind: u8,
    pub fingerprint: [u8; 32],
    pub period_start: i64,
    pub period_end: i64,
    pub source: u8,
    pub partner_signed: bool,
    pub partner_commitment: [u8; 32],
    pub reason: u8,
    pub chain: [u8; 32],
    pub publisher: Pubkey,
}

#[error_code]
pub enum HealthError {
    #[msg("Only the publisher named at initialisation can record")]
    NotPublisher,
    #[msg("Only the program's upgrade authority can initialise it")]
    NotUpgradeAuthority,
    #[msg("That isn't this program's program data account")]
    WrongProgramData,
    #[msg("The sequence number must be exactly one more than the last")]
    SequenceNotNext,
    #[msg("The sequence number can't grow any further")]
    SequenceOverflow,
    #[msg("That record is for another subject")]
    WrongSubject,
    #[msg("A period must end after it starts")]
    EmptyPeriod,
    #[msg("A period must start exactly where the last one ended")]
    PeriodNotContiguous,
    #[msg("A period can't end in the future")]
    PeriodInFuture,
    #[msg("A snapshot needs a fingerprint")]
    EmptyFingerprint,
    #[msg("Unknown source flag")]
    UnknownSource,
}
