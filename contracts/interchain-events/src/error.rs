use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Subscription not found: {id}")]
    SubscriptionNotFound { id: u64 },

    #[error("Subscription {id} is not active")]
    SubscriptionNotActive { id: u64 },

    #[error("Subscription {id} has expired")]
    SubscriptionExpired { id: u64 },

    #[error("key_path must have at least 1 element (store name)")]
    EmptyKeyPath,

    #[error("callback_contract cannot be empty")]
    EmptyCallbackContract,

    #[error("watch_key cannot be empty")]
    EmptyWatchKey,

    #[error("Submitted key does not match subscription watch_key")]
    KeyMismatch,

    #[error("Proven value does not match expected value")]
    ValueMismatch,

    #[error("Proven value does not meet threshold condition")]
    ThresholdNotMet,

    #[error("Cannot decode value for comparison: {reason}")]
    ValueDecodeError { reason: String },

    #[error("Proof verification failed: {reason}")]
    ProofVerificationFailed { reason: String },

    #[error("Proto decode error: {reason}")]
    ProtoDecode { reason: String },
}
