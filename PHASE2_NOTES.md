# Phase 2 — Architecture Notes

## Subscriber Contracts (modular action system)

Instead of storing raw `StoredAction` (protobuf messages) in the core contract, each watch/subscription becomes a **separate subscriber contract** that implements a standard interface.

### Pattern (inspired by DAO DAO voting modules)

- **interchain-events** = core contract (verifies ICS-23 proofs, manages registry of subscribers)
- **subscriber contracts** = user-defined contracts, each implementing a standard interface
- Anyone can write and propose their own subscriber contract with any action logic

### Registration flow

1. User calls `RegisterSubscriber { code_id, init_msg, client_id, key_path, condition }` on the core
2. Core **instantiates** the subscriber contract via `WasmMsg::Instantiate` (core becomes admin)
3. In the `Reply` handler, core **queries** the new contract with `SubscriberInfo {}` to validate the interface
4. If the subscriber responds correctly → registered, address stored
5. If it fails → everything reverts atomically, subscriber never created

This ensures:
- Interface compliance is verified at registration time (duck typing)
- Core is admin of all subscribers (can migrate/kill if needed)
- Instantiation + validation is atomic (same tx)

### Standard interface crate: `interchain-events-interface`

Published as a Rust crate that subscriber contracts import:

```rust
// Execute messages the core will send to the subscriber
#[cw_serde]
pub enum SubscriberExecuteMsg {
    /// Called by the core when a proof is successfully verified
    OnProofVerified {
        key: Binary,
        value: Binary,
        height: Height,
    },
}

// Query messages the core will use to validate the subscriber
#[cw_serde]
pub enum SubscriberQueryMsg {
    /// Must return SubscriberInfoResponse
    SubscriberInfo {},
}

#[cw_serde]
pub struct SubscriberInfoResponse {
    pub version: String,
    pub description: String,
}
```

### Benefits

- **Any action type**: send tokens, call other contracts, ICA, ICS-20 transfers, governance votes...
- **Custom logic**: subscribers can have their own state, track history, aggregate multiple proofs, implement thresholds
- **Composability**: subscribers can call other subscribers, chain reactions
- **Permissionless**: anyone deploys their subscriber code_id, registers it on the core
- **Isolated failures**: if a subscriber panics, only that subscription fails (use SubMsg with gas limit)

### Safety considerations

- **Gas griefing**: call subscriber via SubMsg with a gas limit cap
- **Reentrance**: lock state during subscriber callback execution
- **Spam prevention**: require a deposit to register a subscriber
- **Admin control**: core is admin of all subscriber contracts it instantiates

---

## Watcher Query Improvements

Add a query for watchers to efficiently discover what to monitor:

```rust
QueryMsg::ActiveWatchesByClient {
    client_id: String,
} -> ActiveWatchesResponse {
    watches: Vec<WatchInfo>,
}

WatchInfo {
    subscription_id: u64,
    subscriber_address: String,
    client_id: String,
    key_path: Vec<String>,
    condition: SubscriptionCondition,
}
```

Watchers can filter by `client_id` — one watcher per chain:
- Neutron watcher queries `active_watches_by_client("07-tendermint-42")`
- Osmosis watcher queries `active_watches_by_client("07-tendermint-XX")`

This enables a **watcher marketplace** where operators specialize per chain.

---

## Streaming Subscriptions

For monitoring sequential data (event logs, settlement queues):

```rust
StreamingSubscription {
    subscriber: Addr,
    client_id: String,
    key_prefix: String,
    last_processed_index: u64,
    status: Active | Paused,
}
```

Watcher submits proof for `key_prefix + (last_processed_index + 1)`. If it exists, the core calls `OnProofVerified` on the subscriber and increments the index. Subscription stays active until paused or killed.

---

## Design Principle: One Watch = One Key = One Proof

The core contract stays simple: each watch monitors exactly **one key** on a remote chain. No built-in AND/OR/multi-condition logic.

### Multi-condition via independent contracts (works with current POC)

For complex conditions, the user deploys an **independent smart contract** and points multiple watches at it. No special interface needed — the watches just use `MsgExecuteContract` as their action:

```
Watch 1 (key A) → action: MsgExecuteContract { contract: S1, msg: {"key_a_verified": {value}} }
Watch 2 (key B) → action: MsgExecuteContract { contract: S1, msg: {"key_b_verified": {value}} }
Watch 3 (key C) → action: MsgExecuteContract { contract: S1, msg: {"key_c_verified": {value}} }
```

S1 is a fully independent contract deployed by the user:
- Receives individual proof results from the core
- Manages its own accumulation state ("A verified at H1, B not yet")
- Implements its own AND/OR/threshold/expiration logic
- Triggers the final action when its internal conditions are met

This already works with the current `StoredAction { type_url, value }` design — no changes to the core needed. The user composes freely, the core knows nothing about multi-condition logic.

The subscriber contract pattern (factory, standard interface, admin control) described below is an optional enhancement on top of this — providing convenience, discoverability, and safety guarantees for a marketplace of subscriber contracts.

---

## Dual-Proof Change Detection

For detecting state transitions (value changed from X to Y):

- Submitter provides proofs at height H-1 and H
- Core verifies both proofs
- Calls subscriber with both old and new values
- Anti-replay: `H > last_verified_height`
