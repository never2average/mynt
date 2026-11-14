// Adapted from OnRe's onre-sol (MIT, Copyright (c) 2025 On Re Limited; see LICENSES/onre-sol.LICENSE.md and
// UPSTREAM.json): programs/onreapp/src/utils/ed25519_parser.rs and utils/approver/approver_utils.rs at
// c0490831f438074562ebf51e437ca5f8e027596b. Changes: the signed message is compared byte for byte with the one the
// treasury expects (instead of deserialised), the approver set is the pool's attesters, and the errors are the
// treasury's.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

use crate::TreasuryError;

/// The Ed25519 signature-verification precompile.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Parsed components of an Ed25519 signature verification instruction.
pub struct ParsedEd25519 {
    pub pubkey: [u8; 32],
    pub message: Vec<u8>,
}

/// Parses the Ed25519 precompile's instruction data. Exactly one signature, and the signature, key and message must
/// all be read from that instruction itself (index u16::MAX), so nothing can be pulled in from another instruction.
pub fn parse_ed25519_ix(data: &[u8]) -> Option<ParsedEd25519> {
    if data.len() < 16 || data[0] != 1 {
        return None;
    }
    let sig_ix_index = u16::from_le_bytes([data[4], data[5]]);
    let pubkey_ix_index = u16::from_le_bytes([data[8], data[9]]);
    let msg_ix_index = u16::from_le_bytes([data[14], data[15]]);
    if sig_ix_index != u16::MAX || pubkey_ix_index != u16::MAX || msg_ix_index != u16::MAX {
        return None;
    }
    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    if sig_offset.checked_add(64)? > data.len() || pubkey_offset.checked_add(32)? > data.len() || msg_offset.checked_add(msg_size)? > data.len() {
        return None;
    }
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&data[pubkey_offset..pubkey_offset + 32]);
    Some(ParsedEd25519 { pubkey, message: data[msg_offset..msg_offset + msg_size].to_vec() })
}

/// Checks that the instruction just before this one is an Ed25519 verification, by one of `attesters`, of exactly
/// `expected`. The precompile has already checked the signature itself, or the transaction wouldn't be running.
/// Returns the attester that signed.
pub fn verify_attestation(instructions: &AccountInfo, attesters: &[Pubkey; 2], expected: &[u8]) -> Result<Pubkey> {
    let current = load_current_index_checked(instructions).map_err(|_| error!(TreasuryError::MissingAttestation))?;
    require!(current > 0, TreasuryError::MissingAttestation);
    let ix = load_instruction_at_checked((current - 1) as usize, instructions).map_err(|_| error!(TreasuryError::MissingAttestation))?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, TreasuryError::MissingAttestation);
    require!(ix.accounts.is_empty(), TreasuryError::MalformedAttestation);
    let parsed = parse_ed25519_ix(&ix.data).ok_or(error!(TreasuryError::MalformedAttestation))?;
    let signer = attesters
        .iter()
        .find(|a| **a != Pubkey::default() && a.to_bytes() == parsed.pubkey)
        .ok_or(error!(TreasuryError::UnknownAttester))?;
    require!(parsed.message == expected, TreasuryError::AttestationMismatch);
    Ok(*signer)
}
