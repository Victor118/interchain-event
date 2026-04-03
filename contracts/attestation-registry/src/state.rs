use cosmwasm_schema::cw_serde;
use cw_storage_plus::Map;

#[cw_serde]
pub struct Attestation {
    pub status: String,
    pub attester: String,
    pub height: u64,
}

/// Map from attestation ID to attestation data.
/// Storage key prefix: "attestations"
/// Full key in KV store: wasm/contracts/{contract_addr}/attestations/{id}
pub const ATTESTATIONS: Map<&str, Attestation> = Map::new("attestations");
