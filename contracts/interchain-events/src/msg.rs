use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Binary;
use cross_chain_shared::types::{Height, Subscription, SubscriptionCondition, WatchInfo};

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Register a new one-shot subscription.
    /// When the proof is verified, the contract calls `callback_contract` with `callback_msg`.
    Subscribe {
        /// IBC light client ID tracking the remote chain (e.g., "07-tendermint-42").
        client_id: String,
        /// Merkle key path: ["store_name"] (e.g., ["wasm"]).
        key_path: Vec<String>,
        /// The exact IAVL key to watch (raw bytes). The submitted proof must match this key.
        watch_key: Binary,
        /// Condition to evaluate against the proven value.
        condition: SubscriptionCondition,
        /// Contract address to call when the condition is verified.
        callback_contract: String,
        /// JSON-encoded message to send to the callback contract.
        callback_msg: Binary,
        /// Optional expiry in blocks from creation.
        expires_after_blocks: Option<u64>,
    },

    /// Submit an ICS-23 Merkle proof to trigger a subscription.
    SubmitProof {
        subscription_id: u64,
        /// Height on the remote chain at which the proof was generated.
        height: Height,
        /// AppHash (multistore root) at the given height.
        /// In production this would be read from the IBC light client ConsensusState on-chain.
        /// For the POC, it is provided by the submitter.
        app_hash: Binary,
        /// Protobuf-encoded MerkleProof (two CommitmentProofs: IAVL + SimpleTree).
        proof: Binary,
        /// The key being proven (raw bytes).
        key: Binary,
        /// The value being proven (raw bytes).
        value: Binary,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Get subscription details.
    #[returns(SubscriptionResponse)]
    Subscription { id: u64 },
    /// List all subscriptions.
    #[returns(ListSubscriptionsResponse)]
    ListSubscriptions {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    /// List active watches for a specific IBC client (for watchers).
    #[returns(ActiveWatchesResponse)]
    ActiveWatchesByClient { client_id: String },
}

#[cw_serde]
pub struct SubscriptionResponse {
    pub subscription: Subscription,
}

#[cw_serde]
pub struct ListSubscriptionsResponse {
    pub subscriptions: Vec<Subscription>,
}

#[cw_serde]
pub struct ActiveWatchesResponse {
    pub watches: Vec<WatchInfo>,
}
