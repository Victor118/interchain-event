use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{EventsResponse, ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::state::{Event, EVENTS};

const CONTRACT_NAME: &str = "crates.io:proof-callback";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    EVENTS.save(deps.storage, &vec![])?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::OnProofVerified {} => {
            let mut events = EVENTS.load(deps.storage)?;
            events.push(Event {
                caller: info.sender.to_string(),
                block_height: env.block.height,
            });
            EVENTS.save(deps.storage, &events)?;

            Ok(Response::new()
                .add_attribute("action", "on_proof_verified")
                .add_attribute("caller", info.sender))
        }
    }
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Events {} => {
            let events = EVENTS.load(deps.storage)?;
            to_json_binary(&EventsResponse { events })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{from_json, Addr};

    #[test]
    fn test_full_flow() {
        let mut deps = mock_dependencies();

        // Instantiate
        let info = message_info(&Addr::unchecked("admin"), &[]);
        instantiate(deps.as_mut(), mock_env(), info, InstantiateMsg {}).unwrap();

        // No events yet
        let res: EventsResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Events {}).unwrap()).unwrap();
        assert!(res.events.is_empty());

        // Simulate callback from interchain-events contract
        let info = message_info(&Addr::unchecked("interchain_events_contract"), &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::OnProofVerified {},
        )
        .unwrap();

        // Verify event recorded
        let res: EventsResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Events {}).unwrap()).unwrap();
        assert_eq!(res.events.len(), 1);
        assert_eq!(res.events[0].caller, "interchain_events_contract");

        // Second callback
        let info = message_info(&Addr::unchecked("interchain_events_contract"), &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::OnProofVerified {},
        )
        .unwrap();

        let res: EventsResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Events {}).unwrap()).unwrap();
        assert_eq!(res.events.len(), 2);
    }
}
