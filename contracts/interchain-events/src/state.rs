use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;
use cross_chain_shared::types::Subscription;
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub admin: Addr,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const NEXT_ID: Item<u64> = Item::new("next_id");
pub const SUBSCRIPTIONS: Map<u64, Subscription> = Map::new("subscriptions");
