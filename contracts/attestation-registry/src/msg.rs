use cosmwasm_schema::{cw_serde, QueryResponses};

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Write an attestation. Anyone can attest; the sender is recorded.
    Attest { id: String, status: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Get a single attestation by ID.
    #[returns(AttestationResponse)]
    GetAttestation { id: String },

    /// List attestations with optional pagination.
    #[returns(ListAttestationsResponse)]
    ListAttestations {
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

#[cw_serde]
pub struct AttestationResponse {
    pub id: String,
    pub status: String,
    pub attester: String,
    pub height: u64,
}

#[cw_serde]
pub struct ListAttestationsResponse {
    pub attestations: Vec<AttestationResponse>,
}
