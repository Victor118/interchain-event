use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Attestation ID cannot be empty")]
    EmptyId,

    #[error("Status cannot be empty")]
    EmptyStatus,
}
