use cosmwasm_std::{
    entry_point, to_json_binary, Binary, CosmosMsg, Deps, DepsMut, Env, MessageInfo, Order, Reply,
    Response, StdResult, SubMsg, WasmMsg,
};
use cw2::set_contract_version;
use cw_storage_plus::Bound;

use cross_chain_shared::types::{
    Subscription, SubscriptionCondition, SubscriptionStatus, ValueEncoding, WatchInfo,
};

use crate::error::ContractError;
use crate::msg::{
    ActiveWatchesResponse, ExecuteMsg, InstantiateMsg, ListSubscriptionsResponse, QueryMsg,
    SubscriptionResponse,
};
// POC: proto helpers unused when app_hash is passed as parameter.
// In production, re-enable to query IBC light client ConsensusState on-chain.
// use crate::proto::{encode_consensus_state_request, extract_app_hash};
use crate::state::{Config, CONFIG, NEXT_ID, SUBSCRIPTIONS};
use crate::verification::verify_chained_membership;

use core::cmp::Ordering;

/// Compare two byte slices according to the given encoding.
fn compare_values(
    actual: &[u8],
    threshold: &[u8],
    encoding: &ValueEncoding,
) -> Result<Ordering, ContractError> {
    match encoding {
        ValueEncoding::Bytes => Ok(actual.cmp(threshold)),
        ValueEncoding::String => {
            let a = core::str::from_utf8(actual).map_err(|_| ContractError::ValueDecodeError {
                reason: "actual value is not valid UTF-8".to_string(),
            })?;
            let b =
                core::str::from_utf8(threshold).map_err(|_| ContractError::ValueDecodeError {
                    reason: "threshold is not valid UTF-8".to_string(),
                })?;
            Ok(a.cmp(b))
        }
        ValueEncoding::Numeric => {
            let a = parse_u128(actual)?;
            let b = parse_u128(threshold)?;
            Ok(a.cmp(&b))
        }
    }
}

/// Parse raw bytes as a UTF-8 decimal u128 (handles JSON-quoted strings).
fn parse_u128(bytes: &[u8]) -> Result<u128, ContractError> {
    let s = core::str::from_utf8(bytes).map_err(|_| ContractError::ValueDecodeError {
        reason: "not valid UTF-8".to_string(),
    })?;
    let trimmed = s.trim().trim_matches('"');
    trimmed
        .parse::<u128>()
        .map_err(|_| ContractError::ValueDecodeError {
            reason: format!("cannot parse '{}' as u128", trimmed),
        })
}

const CONTRACT_NAME: &str = "crates.io:interchain-events";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// Instantiate
// ---------------------------------------------------------------------------

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let admin = msg
        .admin
        .map(|a| deps.api.addr_validate(&a))
        .transpose()?
        .unwrap_or(info.sender);

    CONFIG.save(deps.storage, &Config { admin })?;
    NEXT_ID.save(deps.storage, &1u64)?;

    Ok(Response::new().add_attribute("action", "instantiate"))
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Subscribe {
            client_id,
            key_path,
            watch_key,
            condition,
            callback_contract,
            callback_msg,
            expires_after_blocks,
        } => execute_subscribe(
            deps,
            env,
            info,
            client_id,
            key_path,
            watch_key,
            condition,
            callback_contract,
            callback_msg,
            expires_after_blocks,
        ),
        ExecuteMsg::SubmitProof {
            subscription_id,
            height,
            app_hash,
            proof,
            key,
            value,
        } => execute_submit_proof(deps, env, subscription_id, height, app_hash, proof, key, value),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_subscribe(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    client_id: String,
    key_path: Vec<String>,
    watch_key: Binary,
    condition: SubscriptionCondition,
    callback_contract: String,
    callback_msg: Binary,
    expires_after_blocks: Option<u64>,
) -> Result<Response, ContractError> {
    if key_path.is_empty() {
        return Err(ContractError::EmptyKeyPath);
    }
    if watch_key.is_empty() {
        return Err(ContractError::EmptyWatchKey);
    }
    if callback_contract.is_empty() {
        return Err(ContractError::EmptyCallbackContract);
    }

    let id = NEXT_ID.load(deps.storage)?;
    NEXT_ID.save(deps.storage, &(id + 1))?;

    let expires_at = expires_after_blocks.map(|blocks| env.block.height + blocks);

    let subscription = Subscription {
        id,
        creator: info.sender.to_string(),
        client_id,
        key_path,
        watch_key,
        condition,
        callback_contract,
        callback_msg,
        status: SubscriptionStatus::Active,
        created_at: env.block.height,
        expires_at,
    };

    SUBSCRIPTIONS.save(deps.storage, id, &subscription)?;

    Ok(Response::new()
        .add_attribute("action", "subscribe")
        .add_attribute("subscription_id", id.to_string()))
}

fn execute_submit_proof(
    deps: DepsMut,
    env: Env,
    subscription_id: u64,
    _height: cross_chain_shared::types::Height,
    app_hash: Binary,
    proof: Binary,
    key: Binary,
    value: Binary,
) -> Result<Response, ContractError> {
    let mut sub = SUBSCRIPTIONS
        .may_load(deps.storage, subscription_id)?
        .ok_or(ContractError::SubscriptionNotFound {
            id: subscription_id,
        })?;

    // Check status
    if sub.status != SubscriptionStatus::Active {
        return Err(ContractError::SubscriptionNotActive {
            id: subscription_id,
        });
    }

    // Check expiry
    if let Some(expires_at) = sub.expires_at {
        if env.block.height > expires_at {
            sub.status = SubscriptionStatus::Expired;
            SUBSCRIPTIONS.save(deps.storage, subscription_id, &sub)?;
            return Err(ContractError::SubscriptionExpired {
                id: subscription_id,
            });
        }
    }

    // Verify that the submitted key matches the subscription's watch_key
    if key.as_slice() != sub.watch_key.as_slice() {
        return Err(ContractError::KeyMismatch);
    }

    // POC: app_hash is provided by the submitter.
    // In production, this would be read from the IBC light client ConsensusState.

    // Verify two-level ICS-23 proof against the provided app_hash
    verify_chained_membership(&app_hash, proof.as_slice(), &sub.key_path, &key, &value)?;

    // Step 4: Check condition
    match &sub.condition {
        SubscriptionCondition::Exists => {
            // Proof verification success is sufficient
        }
        SubscriptionCondition::Equals { expected } => {
            if value.as_slice() != expected.as_slice() {
                return Err(ContractError::ValueMismatch);
            }
        }
        SubscriptionCondition::GreaterThan {
            threshold,
            encoding,
        } => {
            if compare_values(value.as_slice(), threshold.as_slice(), encoding)?
                != Ordering::Greater
            {
                return Err(ContractError::ThresholdNotMet);
            }
        }
        SubscriptionCondition::LessThan {
            threshold,
            encoding,
        } => {
            if compare_values(value.as_slice(), threshold.as_slice(), encoding)? != Ordering::Less {
                return Err(ContractError::ThresholdNotMet);
            }
        }
        SubscriptionCondition::JsonPathEquals { path, expected } => {
            let json_val: serde_json::Value =
                serde_json::from_slice(value.as_slice()).map_err(|e| {
                    ContractError::ValueDecodeError {
                        reason: format!("invalid JSON: {}", e),
                    }
                })?;

            // Walk the dot-separated path
            let mut current = &json_val;
            for segment in path.split('.') {
                current = current.get(segment).ok_or(ContractError::ValueDecodeError {
                    reason: format!("path '{}' not found (missing '{}')", path, segment),
                })?;
            }

            // Compare: extract the JSON value as a plain string for comparison
            let actual = match current {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Null => "null".to_string(),
                other => other.to_string(),
            };

            if actual != *expected {
                return Err(ContractError::ValueMismatch);
            }
        }
    }

    // Step 5: Mark as triggered (before callback — if callback fails, reply will mark as Failed)
    sub.status = SubscriptionStatus::Triggered;
    SUBSCRIPTIONS.save(deps.storage, subscription_id, &sub)?;

    // Step 6: Call the callback contract via SubMsg
    // If the callback fails, the reply handler catches the error and marks the subscription as Failed.
    // The proof verification itself is NOT reverted.
    let callback = CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: sub.callback_contract.clone(),
        msg: sub.callback_msg.clone(),
        funds: vec![],
    });

    Ok(Response::new()
        .add_submessage(SubMsg::reply_on_error(callback, subscription_id))
        .add_attribute("action", "submit_proof")
        .add_attribute("subscription_id", subscription_id.to_string())
        .add_attribute("callback_contract", sub.callback_contract)
        .add_attribute("status", "triggered"))
}

// ---------------------------------------------------------------------------
// Reply — handle callback failures
// ---------------------------------------------------------------------------

#[entry_point]
pub fn reply(deps: DepsMut, _env: Env, msg: Reply) -> Result<Response, ContractError> {
    // The reply ID is the subscription_id
    let subscription_id = msg.id;

    let error_msg = match msg.result {
        cosmwasm_std::SubMsgResult::Err(err) => err,
        cosmwasm_std::SubMsgResult::Ok(_) => {
            // Should not happen — we only reply on error
            return Ok(Response::new());
        }
    };

    // Mark the subscription as Failed with the error message
    let mut sub = SUBSCRIPTIONS.load(deps.storage, subscription_id)?;
    sub.status = SubscriptionStatus::Failed {
        error: error_msg.clone(),
    };
    SUBSCRIPTIONS.save(deps.storage, subscription_id, &sub)?;

    Ok(Response::new()
        .add_attribute("action", "callback_failed")
        .add_attribute("subscription_id", subscription_id.to_string())
        .add_attribute("error", error_msg))
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Subscription { id } => to_json_binary(&query_subscription(deps, id)?),
        QueryMsg::ListSubscriptions { start_after, limit } => {
            to_json_binary(&query_list_subscriptions(deps, start_after, limit)?)
        }
        QueryMsg::ActiveWatchesByClient { client_id } => {
            to_json_binary(&query_active_watches_by_client(deps, client_id)?)
        }
    }
}

fn query_subscription(deps: Deps, id: u64) -> StdResult<SubscriptionResponse> {
    let subscription = SUBSCRIPTIONS.load(deps.storage, id)?;
    Ok(SubscriptionResponse { subscription })
}

fn query_list_subscriptions(
    deps: Deps,
    start_after: Option<u64>,
    limit: Option<u32>,
) -> StdResult<ListSubscriptionsResponse> {
    let limit = limit.unwrap_or(30).min(100) as usize;
    let start = start_after.map(Bound::exclusive);

    let subscriptions: Vec<Subscription> = SUBSCRIPTIONS
        .range(deps.storage, start, None, Order::Ascending)
        .take(limit)
        .map(|item| item.map(|(_, sub)| sub))
        .collect::<StdResult<_>>()?;

    Ok(ListSubscriptionsResponse { subscriptions })
}

fn query_active_watches_by_client(
    deps: Deps,
    client_id: String,
) -> StdResult<ActiveWatchesResponse> {
    let watches: Vec<WatchInfo> = SUBSCRIPTIONS
        .range(deps.storage, None, None, Order::Ascending)
        .filter_map(|item| {
            item.ok().and_then(|(_, sub)| {
                if sub.status == SubscriptionStatus::Active && sub.client_id == client_id {
                    Some(WatchInfo {
                        subscription_id: sub.id,
                        client_id: sub.client_id,
                        key_path: sub.key_path,
                        watch_key: sub.watch_key,
                        condition: sub.condition,
                    })
                } else {
                    None
                }
            })
        })
        .collect();

    Ok(ActiveWatchesResponse { watches })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{from_json, Addr};

    fn setup(deps: DepsMut) {
        let info = message_info(&Addr::unchecked("admin"), &[]);
        instantiate(deps, mock_env(), info, InstantiateMsg { admin: None }).unwrap();
    }

    fn sample_callback_contract() -> String {
        "callback_contract".to_string()
    }

    fn sample_callback_msg() -> Binary {
        Binary::from(b"{\"on_proof_verified\":{}}".as_slice())
    }

    fn sample_watch_key() -> Binary {
        Binary::from(b"\x03test_contract\x00\x0cattestationstest_key".as_slice())
    }

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let config = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(config.admin, Addr::unchecked("admin"));

        let next_id = NEXT_ID.load(deps.as_ref().storage).unwrap();
        assert_eq!(next_id, 1);
    }

    #[test]
    fn test_subscribe() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("user1"), &[]);
        let msg = ExecuteMsg::Subscribe {
            client_id: "07-tendermint-42".to_string(),
            key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
            condition: SubscriptionCondition::Equals { expected: Binary::from(b"true") },
            callback_contract: sample_callback_contract(),
            callback_msg: sample_callback_msg(),
            expires_after_blocks: Some(1000),
        };

        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(res.attributes[1].value, "1"); // subscription_id

        // Query it back
        let query_res: SubscriptionResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Subscription { id: 1 }).unwrap())
                .unwrap();
        assert_eq!(query_res.subscription.id, 1);
        assert_eq!(query_res.subscription.creator, "user1");
        assert_eq!(query_res.subscription.client_id, "07-tendermint-42");
        assert_eq!(
            query_res.subscription.callback_contract,
            sample_callback_contract()
        );
        assert_eq!(query_res.subscription.status, SubscriptionStatus::Active);
        assert!(matches!(
            query_res.subscription.condition,
            SubscriptionCondition::Equals { .. }
        ));
    }

    #[test]
    fn test_subscribe_exists_condition() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("user1"), &[]);
        let msg = ExecuteMsg::Subscribe {
            client_id: "07-tendermint-1".to_string(),
            key_path: vec!["bank".to_string()],
            watch_key: sample_watch_key(),
            condition: SubscriptionCondition::Exists,
            callback_contract: sample_callback_contract(),
            callback_msg: sample_callback_msg(),
            expires_after_blocks: None,
        };

        execute(deps.as_mut(), mock_env(), info, msg).unwrap();

        let query_res: SubscriptionResponse =
            from_json(query(deps.as_ref(), mock_env(), QueryMsg::Subscription { id: 1 }).unwrap())
                .unwrap();
        assert!(matches!(
            query_res.subscription.condition,
            SubscriptionCondition::Exists
        ));
        assert!(query_res.subscription.expires_at.is_none());
    }

    #[test]
    fn test_subscribe_empty_key_path() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("user1"), &[]);
        let msg = ExecuteMsg::Subscribe {
            client_id: "07-tendermint-1".to_string(),
            key_path: vec![],
            watch_key: sample_watch_key(),
            condition: SubscriptionCondition::Exists,
            callback_contract: sample_callback_contract(),
            callback_msg: sample_callback_msg(),
            expires_after_blocks: None,
        };

        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert!(matches!(err, ContractError::EmptyKeyPath));
    }

    #[test]
    fn test_subscribe_empty_callback_contract() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("user1"), &[]);
        let msg = ExecuteMsg::Subscribe {
            client_id: "07-tendermint-1".to_string(),
            key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
            condition: SubscriptionCondition::Exists,
            callback_contract: "".to_string(),
            callback_msg: sample_callback_msg(),
            expires_after_blocks: None,
        };

        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert!(matches!(err, ContractError::EmptyCallbackContract));
    }

    #[test]
    fn test_submit_proof_subscription_not_found() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let info = message_info(&Addr::unchecked("anyone"), &[]);
        let msg = ExecuteMsg::SubmitProof {
            subscription_id: 999,
            height: cross_chain_shared::types::Height {
                revision_number: 1,
                revision_height: 100,
            },
            app_hash: Binary::from(vec![0; 32]),
            proof: Binary::from(vec![1, 2, 3]),
            key: Binary::from(vec![4, 5]),
            value: Binary::from(vec![6, 7]),
        };

        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert!(matches!(
            err,
            ContractError::SubscriptionNotFound { id: 999 }
        ));
    }

    #[test]
    fn test_submit_proof_not_active() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        // Create a subscription and manually set it to Triggered
        let info = message_info(&Addr::unchecked("user1"), &[]);
        let msg = ExecuteMsg::Subscribe {
            client_id: "07-tendermint-1".to_string(),
            key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
            condition: SubscriptionCondition::Exists,
            callback_contract: sample_callback_contract(),
            callback_msg: sample_callback_msg(),
            expires_after_blocks: None,
        };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap();

        // Manually mark as triggered
        let mut sub = SUBSCRIPTIONS.load(deps.as_ref().storage, 1).unwrap();
        sub.status = SubscriptionStatus::Triggered;
        SUBSCRIPTIONS.save(deps.as_mut().storage, 1, &sub).unwrap();

        let info = message_info(&Addr::unchecked("anyone"), &[]);
        let msg = ExecuteMsg::SubmitProof {
            subscription_id: 1,
            height: cross_chain_shared::types::Height {
                revision_number: 1,
                revision_height: 100,
            },
            app_hash: Binary::from(vec![0; 32]),
            proof: Binary::from(vec![1, 2, 3]),
            key: Binary::from(vec![4, 5]),
            value: Binary::from(vec![6, 7]),
        };

        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert!(matches!(
            err,
            ContractError::SubscriptionNotActive { id: 1 }
        ));
    }

    #[test]
    fn test_list_subscriptions_pagination() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        // Create 3 subscriptions
        for i in 0..3 {
            let info = message_info(&Addr::unchecked(format!("user{i}")), &[]);
            let msg = ExecuteMsg::Subscribe {
                client_id: format!("07-tendermint-{i}"),
                key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
                condition: SubscriptionCondition::Exists,
                callback_contract: sample_callback_contract(),
                callback_msg: sample_callback_msg(),
                expires_after_blocks: None,
            };
            execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        }

        // List all
        let res: ListSubscriptionsResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ListSubscriptions {
                    start_after: None,
                    limit: None,
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.subscriptions.len(), 3);

        // List with limit
        let res: ListSubscriptionsResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ListSubscriptions {
                    start_after: None,
                    limit: Some(2),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.subscriptions.len(), 2);

        // List with start_after
        let res: ListSubscriptionsResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ListSubscriptions {
                    start_after: Some(1),
                    limit: None,
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.subscriptions.len(), 2);
        assert_eq!(res.subscriptions[0].id, 2);
        assert_eq!(res.subscriptions[1].id, 3);
    }

    #[test]
    fn test_subscribe_auto_increment_ids() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        for _ in 0..3 {
            let info = message_info(&Addr::unchecked("user"), &[]);
            let msg = ExecuteMsg::Subscribe {
                client_id: "07-tendermint-1".to_string(),
                key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
                condition: SubscriptionCondition::Exists,
                callback_contract: sample_callback_contract(),
                callback_msg: sample_callback_msg(),
                expires_after_blocks: None,
            };
            execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        }

        let next_id = NEXT_ID.load(deps.as_ref().storage).unwrap();
        assert_eq!(next_id, 4);
    }

    #[test]
    fn test_active_watches_by_client() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        // Create subscriptions for different clients
        for i in 0..3 {
            let info = message_info(&Addr::unchecked("user"), &[]);
            let msg = ExecuteMsg::Subscribe {
                client_id: "07-tendermint-42".to_string(),
                key_path: vec!["wasm".to_string()],
            watch_key: sample_watch_key(),
                condition: SubscriptionCondition::Exists,
                callback_contract: sample_callback_contract(),
                callback_msg: sample_callback_msg(),
                expires_after_blocks: None,
            };
            execute(deps.as_mut(), mock_env(), info.clone(), msg).unwrap();

            // Also create one for a different client
            if i == 0 {
                let msg2 = ExecuteMsg::Subscribe {
                    client_id: "07-tendermint-99".to_string(),
                    key_path: vec!["bank".to_string()],
                    watch_key: sample_watch_key(),
                    condition: SubscriptionCondition::Exists,
                    callback_contract: sample_callback_contract(),
                    callback_msg: sample_callback_msg(),
                    expires_after_blocks: None,
                };
                execute(deps.as_mut(), mock_env(), info, msg2).unwrap();
            }
        }

        // Mark one as triggered
        let mut sub = SUBSCRIPTIONS.load(deps.as_ref().storage, 1).unwrap();
        sub.status = SubscriptionStatus::Triggered;
        SUBSCRIPTIONS.save(deps.as_mut().storage, 1, &sub).unwrap();

        // Query active watches for client 42
        let res: ActiveWatchesResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ActiveWatchesByClient {
                    client_id: "07-tendermint-42".to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        // 3 created for client 42, but 1 is triggered → 2 active
        assert_eq!(res.watches.len(), 2);
        assert!(res
            .watches
            .iter()
            .all(|w| w.client_id == "07-tendermint-42"));

        // Query active watches for client 99
        let res: ActiveWatchesResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ActiveWatchesByClient {
                    client_id: "07-tendermint-99".to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.watches.len(), 1);

        // Query for non-existent client
        let res: ActiveWatchesResponse = from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::ActiveWatchesByClient {
                    client_id: "07-tendermint-0".to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(res.watches.len(), 0);
    }
}
