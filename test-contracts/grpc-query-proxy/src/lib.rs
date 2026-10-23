//! Forwards a raw, protobuf-encoded gRPC query to the chain and returns the
//! raw protobuf response. The chain's gRPC accept list still decides which
//! paths are reachable; this contract only lets tests drive it from Go.

use cosmwasm_schema::cw_serde;
use cosmwasm_std::{entry_point, Binary, Deps, DepsMut, Empty, Env, MessageInfo, Response, StdResult};

#[cw_serde]
pub enum QueryMsg {
    Grpc { path: String, data: Binary },
}

#[entry_point]
pub fn instantiate(_: DepsMut, _: Env, _: MessageInfo, _: Empty) -> StdResult<Response> {
    Ok(Response::default())
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Grpc { path, data } => {
            // query_grpc returns the raw protobuf response, unlike query() which parses JSON.
            let res = deps.querier.query_grpc(path, data)?;
            cosmwasm_std::to_json_binary(&res)
        }
    }
}
