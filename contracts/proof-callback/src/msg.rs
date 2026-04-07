use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Binary;

use crate::state::Event;

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Called by interchain-events when a proof is verified.
    /// Receives the subscription ID, the full proven value, the proof height,
    /// and the original callback_msg defined at subscription time.
    InterchainEvent {
        subscription_id: u64,
        proven_value: String,
        height: cross_chain_shared::types::Height,
        callback_msg: Binary,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Returns all recorded proof events.
    #[returns(EventsResponse)]
    Events {},
}

#[cw_serde]
pub struct EventsResponse {
    pub events: Vec<Event>,
}
