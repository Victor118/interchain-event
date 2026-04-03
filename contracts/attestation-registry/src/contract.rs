use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response,
    StdResult,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::{
    AttestationResponse, ExecuteMsg, InstantiateMsg, ListAttestationsResponse, QueryMsg,
};
use crate::state::{Attestation, ATTESTATIONS};

const CONTRACT_NAME: &str = "crates.io:attestation-registry";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
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
        ExecuteMsg::Attest { id, status } => execute_attest(deps, env, info, id, status),
    }
}

fn execute_attest(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    id: String,
    status: String,
) -> Result<Response, ContractError> {
    if id.is_empty() {
        return Err(ContractError::EmptyId);
    }
    if status.is_empty() {
        return Err(ContractError::EmptyStatus);
    }

    let attestation = Attestation {
        status: status.clone(),
        attester: info.sender.to_string(),
        height: env.block.height,
    };

    ATTESTATIONS.save(deps.storage, &id, &attestation)?;

    Ok(Response::new()
        .add_attribute("action", "attest")
        .add_attribute("id", id)
        .add_attribute("status", status)
        .add_attribute("attester", info.sender))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::GetAttestation { id } => to_json_binary(&query_attestation(deps, id)?),
        QueryMsg::ListAttestations { start_after, limit } => {
            to_json_binary(&query_list_attestations(deps, start_after, limit)?)
        }
    }
}

fn query_attestation(deps: Deps, id: String) -> StdResult<AttestationResponse> {
    let attestation = ATTESTATIONS.load(deps.storage, &id)?;
    Ok(AttestationResponse {
        id,
        status: attestation.status,
        attester: attestation.attester,
        height: attestation.height,
    })
}

fn query_list_attestations(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<ListAttestationsResponse> {
    let limit = limit.unwrap_or(30).min(100) as usize;
    let start = start_after.as_deref().map(cw_storage_plus::Bound::exclusive);

    let attestations: Vec<AttestationResponse> = ATTESTATIONS
        .range(deps.storage, start, None, Order::Ascending)
        .take(limit)
        .map(|item| {
            let (id, attestation) = item?;
            Ok(AttestationResponse {
                id,
                status: attestation.status,
                attester: attestation.attester,
                height: attestation.height,
            })
        })
        .collect::<StdResult<_>>()?;

    Ok(ListAttestationsResponse { attestations })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::Addr;

    fn setup(deps: DepsMut) {
        let info = message_info(&Addr::unchecked("creator"), &[]);
        instantiate(deps, mock_env(), info, InstantiateMsg {}).unwrap();
    }

    #[test]
    fn test_attest_and_query() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("charlie"), &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Attest {
                id: "order_42".to_string(),
                status: "delivered".to_string(),
            },
        )
        .unwrap();

        let res: AttestationResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::GetAttestation {
                    id: "order_42".to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(res.id, "order_42");
        assert_eq!(res.status, "delivered");
        assert_eq!(res.attester, "charlie");
    }

    #[test]
    fn test_attest_overwrites() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("charlie"), &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            ExecuteMsg::Attest {
                id: "order_42".to_string(),
                status: "pending".to_string(),
            },
        )
        .unwrap();

        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Attest {
                id: "order_42".to_string(),
                status: "delivered".to_string(),
            },
        )
        .unwrap();

        let res: AttestationResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::GetAttestation {
                    id: "order_42".to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(res.status, "delivered");
    }

    #[test]
    fn test_empty_id_rejected() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("charlie"), &[]);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Attest {
                id: "".to_string(),
                status: "delivered".to_string(),
            },
        )
        .unwrap_err();

        assert!(matches!(err, ContractError::EmptyId));
    }

    #[test]
    fn test_list_attestations() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("charlie"), &[]);
        for i in 0..5 {
            execute(
                deps.as_mut(),
                mock_env(),
                info.clone(),
                ExecuteMsg::Attest {
                    id: format!("order_{i}"),
                    status: "delivered".to_string(),
                },
            )
            .unwrap();
        }

        let res: ListAttestationsResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ListAttestations {
                    start_after: None,
                    limit: Some(3),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(res.attestations.len(), 3);
    }
}
