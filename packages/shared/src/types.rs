use cosmwasm_schema::cw_serde;
use cosmwasm_std::Binary;

/// A height on a remote chain (revision_number, revision_height).
#[cw_serde]
pub struct Height {
    pub revision_number: u64,
    pub revision_height: u64,
}

/// How to interpret raw bytes for comparison.
#[cw_serde]
pub enum ValueEncoding {
    /// Lexicographic comparison on raw bytes.
    Bytes,
    /// Decode as UTF-8, compare alphabetically.
    String,
    /// Parse as UTF-8 decimal string to u128, compare numerically.
    Numeric,
}

/// Condition for subscription trigger.
#[cw_serde]
pub enum SubscriptionCondition {
    /// Key must exist (any value).
    Exists,
    /// Value at key must equal expected bytes (raw comparison).
    Equals { expected: Binary },
    /// Proven value must be strictly greater than threshold.
    GreaterThan {
        threshold: Binary,
        encoding: ValueEncoding,
    },
    /// Proven value must be strictly less than threshold.
    LessThan {
        threshold: Binary,
        encoding: ValueEncoding,
    },
    /// Parse the proven value as JSON and check that a field matches.
    /// `path` is a dot-separated path into the JSON object (e.g. "status" or "result.score").
    /// `expected` is the expected JSON value as a string (e.g. "approved", "42", "true").
    JsonPathEquals { path: String, expected: String },
}

/// Status lifecycle for a subscription.
#[cw_serde]
pub enum SubscriptionStatus {
    Active,
    Triggered,
    Expired,
    /// Proof was verified but the callback contract failed.
    Failed { error: String },
}

/// Full subscription state.
#[cw_serde]
pub struct Subscription {
    pub id: u64,
    pub creator: String,
    pub client_id: String,
    pub key_path: Vec<String>,
    pub condition: SubscriptionCondition,
    /// Contract to call when the proof is verified.
    pub callback_contract: String,
    /// Message to send to the callback contract (JSON-encoded ExecuteMsg).
    pub callback_msg: Binary,
    pub status: SubscriptionStatus,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

/// Info returned by ActiveWatchesByClient query — minimal data for watchers.
#[cw_serde]
pub struct WatchInfo {
    pub subscription_id: u64,
    pub client_id: String,
    pub key_path: Vec<String>,
    pub condition: SubscriptionCondition,
}
