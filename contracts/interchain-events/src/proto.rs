/// Manual protobuf structs for IBC ConsensusState queries and MerkleProof decoding.
/// Uses prost derive macros to keep binary size minimal (no cosmos-sdk-proto dependency).
use prost::Message;

// ---------------------------------------------------------------------------
// google.protobuf.Any
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct Any {
    #[prost(string, tag = "1")]
    pub type_url: String,
    #[prost(bytes = "vec", tag = "2")]
    pub value: Vec<u8>,
}

// ---------------------------------------------------------------------------
// ibc.core.client.v1.Height
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct ProtoHeight {
    #[prost(uint64, tag = "1")]
    pub revision_number: u64,
    #[prost(uint64, tag = "2")]
    pub revision_height: u64,
}

// ---------------------------------------------------------------------------
// ibc.core.client.v1.QueryConsensusStateRequest
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct QueryConsensusStateRequest {
    #[prost(string, tag = "1")]
    pub client_id: String,
    #[prost(uint64, tag = "2")]
    pub revision_number: u64,
    #[prost(uint64, tag = "3")]
    pub revision_height: u64,
    #[prost(bool, tag = "4")]
    pub latest_height: bool,
}

// ---------------------------------------------------------------------------
// ibc.core.client.v1.QueryConsensusStateResponse
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct QueryConsensusStateResponse {
    /// The consensus state, wrapped in google.protobuf.Any.
    #[prost(message, optional, tag = "1")]
    pub consensus_state: Option<Any>,
    #[prost(bytes = "vec", tag = "2")]
    pub proof: Vec<u8>,
    #[prost(message, optional, tag = "3")]
    pub proof_height: Option<ProtoHeight>,
}

// ---------------------------------------------------------------------------
// google.protobuf.Timestamp
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct Timestamp {
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}

// ---------------------------------------------------------------------------
// ibc.core.commitment.v1.MerkleRoot
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct MerkleRoot {
    #[prost(bytes = "vec", tag = "1")]
    pub hash: Vec<u8>,
}

// ---------------------------------------------------------------------------
// ibc.lightclients.tendermint.v1.ConsensusState
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct TendermintConsensusState {
    #[prost(message, optional, tag = "1")]
    pub timestamp: Option<Timestamp>,
    #[prost(message, optional, tag = "2")]
    pub root: Option<MerkleRoot>,
    #[prost(bytes = "vec", tag = "3")]
    pub next_validators_hash: Vec<u8>,
}

// ---------------------------------------------------------------------------
// ibc.core.commitment.v1.MerkleProof
// Contains two ics23.CommitmentProof entries:
//   [0] = IAVL proof (module level)
//   [1] = SimpleTree proof (multistore level)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
pub struct MerkleProof {
    #[prost(bytes = "vec", repeated, tag = "1")]
    pub proofs: Vec<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// Encoding / decoding helpers
// ---------------------------------------------------------------------------

use crate::error::ContractError;

/// Encode a QueryConsensusStateRequest for the Stargate/gRPC query.
pub fn encode_consensus_state_request(
    client_id: &str,
    revision_number: u64,
    revision_height: u64,
) -> Vec<u8> {
    let req = QueryConsensusStateRequest {
        client_id: client_id.to_string(),
        revision_number,
        revision_height,
        latest_height: false,
    };
    req.encode_to_vec()
}

/// Decode a QueryConsensusStateResponse and extract the AppHash (root hash).
pub fn extract_app_hash(response_bytes: &[u8]) -> Result<Vec<u8>, ContractError> {
    let resp = QueryConsensusStateResponse::decode(response_bytes).map_err(|e| {
        ContractError::ProtoDecode {
            reason: format!("QueryConsensusStateResponse: {e}"),
        }
    })?;

    let any = resp.consensus_state.ok_or(ContractError::ProtoDecode {
        reason: "missing consensus_state field".to_string(),
    })?;

    let cs = TendermintConsensusState::decode(any.value.as_slice()).map_err(|e| {
        ContractError::ProtoDecode {
            reason: format!("TendermintConsensusState: {e}"),
        }
    })?;

    let root = cs.root.ok_or(ContractError::ProtoDecode {
        reason: "missing root field in ConsensusState".to_string(),
    })?;

    if root.hash.is_empty() {
        return Err(ContractError::ProtoDecode {
            reason: "empty root hash in ConsensusState".to_string(),
        });
    }

    Ok(root.hash)
}

/// Decode a MerkleProof from protobuf bytes.
/// Returns the raw bytes of each CommitmentProof (expected: 2 entries).
pub fn decode_merkle_proof(proof_bytes: &[u8]) -> Result<Vec<Vec<u8>>, ContractError> {
    let mp = MerkleProof::decode(proof_bytes).map_err(|e| ContractError::ProtoDecode {
        reason: format!("MerkleProof: {e}"),
    })?;

    if mp.proofs.len() != 2 {
        return Err(ContractError::ProofVerificationFailed {
            reason: format!(
                "expected 2 CommitmentProofs in MerkleProof, got {}",
                mp.proofs.len()
            ),
        });
    }

    Ok(mp.proofs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_consensus_state_request_roundtrip() {
        let encoded = encode_consensus_state_request("07-tendermint-42", 1, 12345);
        let decoded = QueryConsensusStateRequest::decode(encoded.as_slice()).unwrap();
        assert_eq!(decoded.client_id, "07-tendermint-42");
        assert_eq!(decoded.revision_number, 1);
        assert_eq!(decoded.revision_height, 12345);
        assert!(!decoded.latest_height);
    }

    #[test]
    fn test_extract_app_hash_valid() {
        let cs = TendermintConsensusState {
            timestamp: Some(Timestamp {
                seconds: 1000,
                nanos: 0,
            }),
            root: Some(MerkleRoot {
                hash: vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            }),
            next_validators_hash: vec![0xAA; 32],
        };
        let any = Any {
            type_url: "/ibc.lightclients.tendermint.v1.ConsensusState".to_string(),
            value: cs.encode_to_vec(),
        };
        let resp = QueryConsensusStateResponse {
            consensus_state: Some(any),
            proof: vec![],
            proof_height: None,
        };
        let resp_bytes = resp.encode_to_vec();

        let hash = extract_app_hash(&resp_bytes).unwrap();
        assert_eq!(
            hash,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
        );
    }

    #[test]
    fn test_extract_app_hash_missing_root() {
        let cs = TendermintConsensusState {
            timestamp: None,
            root: None,
            next_validators_hash: vec![],
        };
        let any = Any {
            type_url: "/ibc.lightclients.tendermint.v1.ConsensusState".to_string(),
            value: cs.encode_to_vec(),
        };
        let resp = QueryConsensusStateResponse {
            consensus_state: Some(any),
            proof: vec![],
            proof_height: None,
        };
        let result = extract_app_hash(&resp.encode_to_vec());
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_merkle_proof_wrong_count() {
        let mp = MerkleProof {
            proofs: vec![vec![1, 2, 3]],
        };
        let result = decode_merkle_proof(&mp.encode_to_vec());
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_merkle_proof_valid() {
        let mp = MerkleProof {
            proofs: vec![vec![1, 2, 3], vec![4, 5, 6]],
        };
        let proofs = decode_merkle_proof(&mp.encode_to_vec()).unwrap();
        assert_eq!(proofs.len(), 2);
        assert_eq!(proofs[0], vec![1, 2, 3]);
        assert_eq!(proofs[1], vec![4, 5, 6]);
    }
}
