use cosmwasm_schema::{cw_serde, QueryResponses};

use crate::state::Event;

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Called by interchain-events when a proof is verified.
    OnProofVerified {},
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
