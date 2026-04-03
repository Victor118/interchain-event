/// Two-level ICS-23 Merkle proof verification.
///
/// Verifies a chained proof against the AppHash from the IBC light client's ConsensusState:
///   1. IAVL proof: proves key/value exists in a module's IAVL tree -> yields module_root
///   2. SimpleTree proof: proves module_root is committed in the AppHash
use ics23::commitment_proof::Proof;
use ics23::{
    calculate_existence_root, iavl_spec, tendermint_spec, verify_membership, CommitmentProof,
    HostFunctionsManager,
};
use prost::Message;

use crate::error::ContractError;
use crate::proto::decode_merkle_proof;

/// Verify a two-level ICS-23 membership proof.
///
/// # Arguments
/// * `app_hash` - The trusted AppHash from ConsensusState (multistore root)
/// * `proof_bytes` - Protobuf-encoded MerkleProof containing 2 CommitmentProofs
/// * `key_path` - `["store_name", ...]` — first element is the store name for the SimpleTree level
/// * `key` - The raw key being proven (IAVL level)
/// * `value` - The raw value being proven (IAVL level)
pub fn verify_chained_membership(
    app_hash: &[u8],
    proof_bytes: &[u8],
    key_path: &[String],
    key: &[u8],
    value: &[u8],
) -> Result<(), ContractError> {
    if key_path.is_empty() {
        return Err(ContractError::EmptyKeyPath);
    }

    let raw_proofs = decode_merkle_proof(proof_bytes)?;

    // Decode both CommitmentProofs
    let iavl_commitment = CommitmentProof::decode(raw_proofs[0].as_slice()).map_err(|e| {
        ContractError::ProtoDecode {
            reason: format!("IAVL CommitmentProof: {e}"),
        }
    })?;
    let simple_commitment = CommitmentProof::decode(raw_proofs[1].as_slice()).map_err(|e| {
        ContractError::ProtoDecode {
            reason: format!("SimpleTree CommitmentProof: {e}"),
        }
    })?;

    // Step 1: Extract ExistenceProof from IAVL CommitmentProof and calculate module root
    let iavl_existence = match &iavl_commitment.proof {
        Some(Proof::Exist(ep)) => ep,
        _ => {
            return Err(ContractError::ProofVerificationFailed {
                reason: "IAVL proof is not an ExistenceProof".to_string(),
            })
        }
    };

    let module_root =
        calculate_existence_root::<HostFunctionsManager>(iavl_existence).map_err(|e| {
            ContractError::ProofVerificationFailed {
                reason: format!("calculate IAVL root: {e}"),
            }
        })?;

    // Step 2: Verify IAVL proof structure against spec + key/value match
    let iavl_valid = verify_membership::<HostFunctionsManager>(
        &iavl_commitment,
        &iavl_spec(),
        &module_root,
        key,
        value,
    );
    if !iavl_valid {
        return Err(ContractError::ProofVerificationFailed {
            reason: "IAVL membership verification failed".to_string(),
        });
    }

    // Step 3: Verify SimpleTree proof — module_root is committed in AppHash
    let store_name = key_path[0].as_bytes();
    let simple_valid = verify_membership::<HostFunctionsManager>(
        &simple_commitment,
        &tendermint_spec(),
        &app_hash.to_vec(),
        store_name,
        &module_root,
    );
    if !simple_valid {
        return Err(ContractError::ProofVerificationFailed {
            reason: "SimpleTree membership verification failed (module root not in AppHash)"
                .to_string(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_chained_membership_empty_key_path() {
        let result = verify_chained_membership(b"apphash", b"proof", &[], b"key", b"value");
        assert!(matches!(result, Err(ContractError::EmptyKeyPath)));
    }

    #[test]
    fn test_verify_chained_membership_invalid_proof_bytes() {
        let key_path = vec!["wasm".to_string()];
        let result =
            verify_chained_membership(b"apphash", b"not valid proto", &key_path, b"key", b"val");
        assert!(matches!(result, Err(ContractError::ProtoDecode { .. })));
    }
}
