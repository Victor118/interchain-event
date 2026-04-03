use cosmwasm_schema::cw_serde;
use cw_storage_plus::Item;

#[cw_serde]
pub struct Event {
    pub caller: String,
    pub block_height: u64,
}

pub const EVENTS: Item<Vec<Event>> = Item::new("events");
