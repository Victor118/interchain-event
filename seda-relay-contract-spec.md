# SEDA Relay — Technical Specification

## Objective

Build a CosmWasm contract on the Cosmos Hub that delivers [SEDA](https://www.seda.xyz/) oracle results to other contracts on the Hub. The only trust assumption is the Hub's IBC light client of `seda-1`.

- No SEDA-specific contract, key or validator set is deployed on the Hub. The trusted root comes from the existing light client `07-tendermint-1372`, which relayers already keep up to date.
- Relaying is permissionless. A relayer cannot forge a result, swap the request for another one, or replay an old result. The worst it can do is not deliver, and a timeout covers that.

The verification has been checked off-chain against mainnet in [`demos/seda-verify`](demos/seda-verify). On the Hub, it requires `/ibc.core.client.v1.Query/VerifyMembership` in Gaia's wasm gRPC accept list ([cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023)).

---

## Architecture Overview

```
 Cosmos Hub                                 Relayer (off-chain)                SEDA (seda-1)
 ──────────                                 ───────────────────                ─────────────
 consumer ──Request{params, bounty}──► relay
                                        │ request_id, memo, dr_id
                                        └─ event seda_request ──────► reads params
                                                                      post_data_request ──► core contract
                                                                      (memo, payback_address = its Hub address)
                                                                                            executors, tally
                                                                      ◄── event tally_completion{dr_id}
                                                                      abci_query batching key, prove=true @H
 tx {                                                                 builds header @H+1
   MsgUpdateClient(07-tendermint-1372, header @H+1)  ◄────────────────┤
   relay.Submit{request_id, dr_block_height, batched, value, proof} ◄─┘
 }
 relay: rebuild key → VerifyMembership → decode DataResult → checks
        → pay bounty to payback_address → callback consumer
```

---

## Key Facts (checked against SEDA source and mainnet)

### 1. `dr_id` commits to every request parameter

`PostDataRequestArgs::try_hash` (`seda-chain-contracts`, `common/src/msgs/data_requests/types.rs`):

```
dr_id = keccak256(
    version.hash()
    ‖ hex_decode(exec_program_id)
    ‖ keccak256(exec_inputs)
    ‖ exec_gas_limit      (u64 BE)
    ‖ hex_decode(tally_program_id)
    ‖ keccak256(tally_inputs)
    ‖ tally_gas_limit     (u64 BE)
    ‖ replication_factor  (u16 BE)
    ‖ keccak256(consensus_filter)
    ‖ gas_price           (u128 BE)
    ‖ keccak256(memo)
)
```

The contract computes the expected `dr_id` itself, with the same function. The [`seda-common-rs`](https://github.com/sedaprotocol/seda-common-rs) crate should be reused rather than reimplementing the hash. If the relayer changes any parameter on SEDA, the result is stored under another `dr_id` and can never be proven for the expected one.

`payback_address` and `seda_payload` are **not** part of the hash.

### 2. Identical parameters give the same `dr_id`

SEDA rejects a request whose `dr_id` already exists (`DataRequestAlreadyExists`, `post_request.rs`). An old result with the same parameters would also verify. The relay therefore **imposes the memo**, which makes every request unique:

```
memo = relay_contract_address (UTF-8) ‖ request_id (u64 BE)
```

The memo has no effect on execution (the tally VM receives it as `DR_MEMO`, and programs are free to ignore it). Its size is capped by SEDA's `memo_limit_in_bytes`.

### 3. Storage key of a data result

SEDA `x/batching` stores results in `dataResults`, a `collections.Map` with prefix `0` and key `Triple[bool, string, uint64]`:

```
store:  "batching"
key:    0x00 | batched (0x00|0x01) | dr_id (hex string, UTF-8) | 0x00 | dr_block_height (u64 BE)
value:  sedachain.batching.v1.DataResult (protobuf)
```

- The result is first written under `batched=false` at the tally block T, then moved to `batched=true` once included in a batch. Both are genuine states, so the contract accepts either.
- `dr_block_height` is the SEDA height at which the request was posted. It is only known after posting, so the relayer provides it.

> This layout is SEDA's internal store format, not a public API. A SEDA upgrade could change it (see [Open Questions](#open-questions)).

### 4. `DataResult` fields

```protobuf
message DataResult {
  string id              = 1;   // keccak256 of the data result
  string dr_id           = 2;
  uint64 dr_block_height = 3;
  string version         = 4;
  uint64 block_height    = 5;   // tally height
  uint64 block_timestamp = 6;   // tally time, unix seconds
  uint32 exit_code       = 7;   // tally program exit code, 0 = success
  string gas_used        = 8;   // cosmos.Int
  bytes  result          = 9;
  string payback_address = 10;  // base64 of the bytes set by the poster
  string seda_payload    = 11;
  bool   consensus       = 12;
}
```

The contract decodes it with plain protobuf (`prost` or a minimal hand-written decoder, as in the demo).

### 5. `payback_address` binds the reward to the relayer

`payback_address` is free-form bytes (at most `payback_address_limit_in_bytes` = 128) set by whoever posts the request on SEDA. It ends up in the proven `DataResult`, base64-encoded. SEDA designed it so that destination chains can reward the relayer.

The relay pays the bounty to the Hub address encoded in `payback_address`, **not** to the sender of `Submit`. Copying a `Submit` from the mempool gains nothing: the bounty still goes to the relayer that posted the request on SEDA.

```
payback_address = UTF-8 bytes of the relayer's Hub bech32 address (cosmos1…)
```

### 6. Detecting completion

At the end of the tally block, SEDA emits `tally_completion` (`x/tally/keeper/endblock.go`) with attributes `id`, `dr_id`, `consensus`, `exit_code`, etc. It is a `finalize_block` event, not a transaction event. Alternatively, a relayer can poll `GET /seda-chain/batching/data_result/{dr_id}`, which returns not-found until the tally.

### 7. Proof height

The result is in SEDA's state from the tally block T onward. A proof queried at height `H ≥ T` verifies against the AppHash in the header of block `H+1`, so the Hub client needs a consensus state at `H+1`.

---

## Contract Design

### Instantiate

```rust
#[cw_serde]
pub struct InstantiateMsg {
    /// Hub IBC client tracking seda-1, e.g. "07-tendermint-1372". Fixed: never taken from a message.
    pub client_id: String,
    /// Chain id tracked by client_id ("seda-1"). Informational: ClientState is not in the accept list,
    /// so the deployer checks it off-chain before instantiating.
    pub seda_chain_id: String,
    /// Denom accepted for bounties, e.g. "uatom".
    pub bounty_denom: String,
    /// Minimum and maximum timeout for a request, in seconds.
    pub min_timeout: u64,
    pub max_timeout: u64,
    /// Optional floor on the oracle security parameters.
    pub min_replication_factor: u16,
    /// Gas limit for the consumer callback.
    pub callback_gas_limit: u64,
}
```

`client_id` is stored in the config and can only be changed by governance, through the contract admin. A client ID taken from a message would let a relayer point to a client it controls.

### Execute

```rust
#[cw_serde]
pub enum ExecuteMsg {
    /// Called by a consumer contract (or any account). Funds: the bounty, in bounty_denom.
    Request {
        /// SEDA request parameters, except memo (imposed by the relay).
        version: String,
        exec_program_id: String,    // hex, 32 bytes
        exec_inputs: Binary,
        exec_gas_limit: u64,
        tally_program_id: String,   // hex, 32 bytes
        tally_inputs: Binary,
        tally_gas_limit: u64,
        replication_factor: u16,
        consensus_filter: Binary,
        gas_price: Uint128,
        /// Seconds after which the requester can reclaim the bounty.
        timeout: u64,
        /// Whether to call back the requester when the result is delivered.
        callback: bool,
    },

    /// Called by a relayer, usually right after MsgUpdateClient in the same tx.
    Submit {
        request_id: u64,
        dr_block_height: u64,
        batched: bool,
        /// Raw DataResult protobuf, as stored on SEDA.
        value: Binary,
        /// MerkleProof (ICS23 proofs, IAVL then multistore), protobuf.
        proof: Binary,
        /// Height of the Hub consensus state to verify against (H+1).
        proof_height: Height,   // { revision_number, revision_height }
    },

    /// Called by the requester after the timeout, if nothing was delivered.
    Reclaim { request_id: u64 },
}
```

### State

```rust
pub const CONFIG: Item<Config> = Item::new("config");
pub const NEXT_REQUEST_ID: Item<u64> = Item::new("next_id");
pub const REQUESTS: Map<u64, Request> = Map::new("requests");
/// dr_id (32 bytes) → request_id, to look up a request from a SEDA event.
pub const BY_DR_ID: Map<&[u8], u64> = Map::new("by_dr_id");

#[cw_serde]
pub struct Request {
    pub requester: Addr,
    pub args: PostDataRequestArgs,  // memo included
    pub dr_id: [u8; 32],
    pub bounty: Coin,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub callback: bool,
    pub status: Status,
}

#[cw_serde]
pub enum Status {
    Pending,
    Delivered(DeliveredResult),
    Reclaimed,
}

#[cw_serde]
pub struct DeliveredResult {
    pub exit_code: u32,
    pub consensus: bool,
    pub result: Binary,
    pub block_height: u64,        // SEDA tally height
    pub block_timestamp: u64,     // SEDA tally time
    pub relayer: Addr,
}
```

### `Request` handler

1. Validate the parameters as SEDA would, so that a request that SEDA would reject is not accepted: program IDs are 64 hex characters, `replication_factor ≥ max(1, min_replication_factor)`, the version is plain `Major.Minor.Patch`, and the timeout is within `[min_timeout, max_timeout]`.
2. Check that exactly one coin in `bounty_denom` is attached.
3. Set `request_id = NEXT_REQUEST_ID++` and `memo = env.contract.address ‖ request_id (u64 BE)`.
4. Compute `dr_id = args.try_hash()`.
5. Store the request and save `BY_DR_ID[dr_id] = request_id`.
6. Emit an event with everything a relayer needs to post the exact same request:

```
wasm-seda_request
  request_id, dr_id (hex), bounty, expires_at,
  version, exec_program_id, exec_inputs (base64), exec_gas_limit,
  tally_program_id, tally_inputs (base64), tally_gas_limit,
  replication_factor, consensus_filter (base64), gas_price, memo (base64)
```

The same data is available through the `Request` query, for relayers that start late.

### `Submit` handler

The relayer is trusted for nothing except the proof bytes. Every check below uses the contract's own data.

```
1.  req = REQUESTS[request_id]
    require req.status == Pending
    (a Submit after expires_at is still accepted while Pending: the result is real and the relayer did the work)

2.  key = 0x00 | (batched ? 0x01 : 0x00) | hex(req.dr_id) | 0x00 | dr_block_height (u64 BE)
    — built here, from the expected dr_id. No key is ever taken from the message.

3.  res = grpc /ibc.core.client.v1.Query/VerifyMembership {
          client_id:    config.client_id,
          proof:        proof,
          proof_height: proof_height,
          merkle_path:  MerklePath { key_path: ["batching", key] },
          value:        value,
          time_delay:   0,
          block_delay:  0,
      }
    require res.success
    — VerifyMembership also requires the client to be Active (not frozen or expired).

4.  dr = DataResult::decode(value)
    require dr.dr_id == hex(req.dr_id)               (defence in depth: already implied by the key)
    require dr.dr_block_height == dr_block_height

5.  relayer = addr_validate(utf8(base64_decode(dr.payback_address)))
    — if payback_address is not a valid Hub address, the bounty is paid to info.sender.

6.  req.status = Delivered { exit_code, consensus, result, block_height, block_timestamp, relayer }

7.  messages:
      BankMsg::Send { to: relayer, amount: req.bounty }
      if req.callback:
        SubMsg::reply_on_error(WasmMsg::Execute {
            contract_addr: req.requester,
            msg: { "seda_result": { request_id, dr_id, exit_code, consensus, result, block_height, block_timestamp } },
        }).with_gas_limit(config.callback_gas_limit)
```

Notes:

- **The relay does not judge the result.** A `DataResult` with `consensus=false` or `exit_code≠0` (a failed program, a SEDA timeout) is still delivered, and the bounty is still paid: the relayer did its job. The consumer decides what to do with a failure.
- **The callback is isolated.** It uses `reply_on_error` with a gas limit, and the `reply` handler only records the error in an event. A consumer that panics or runs out of gas cannot block delivery or the relayer's payment. The result stays readable through the `Result` query.
- **Updating the client in the same transaction is the default path.** The relayer sends `MsgUpdateClient` (header at `H+1`) and `Submit` in one transaction. Messages execute in order, so `VerifyMembership` sees the new consensus state. If `Submit` fails, the client update is reverted too. If a consensus state already exists at `H+1`, the relayer can leave out `MsgUpdateClient`.

### `Reclaim` handler

Require `info.sender == req.requester`, `status == Pending` and `env.block.time ≥ expires_at`. Refund the bounty and set `status = Reclaimed`.

A late `Submit` after a `Reclaim` is rejected, since the request is no longer `Pending`. The requester chose to stop waiting.

### Queries

```rust
#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(ConfigResponse)]
    Config {},
    /// Full request, including the SEDA parameters to post.
    #[returns(RequestResponse)]
    Request { request_id: u64 },
    #[returns(RequestResponse)]
    RequestByDrId { dr_id: String },
    /// Pending requests, for relayers.
    #[returns(RequestsResponse)]
    Pending { start_after: Option<u64>, limit: Option<u32> },
    /// Delivered result, for consumers that read instead of using the callback.
    #[returns(Option<DeliveredResult>)]
    Result { request_id: u64 },
}
```

---

## Consumer Integration

```rust
// Request: from the consumer's execute handler
let msg = WasmMsg::Execute {
    contract_addr: relay.to_string(),
    msg: to_json_binary(&relay::ExecuteMsg::Request { /* params */, timeout: 3600, callback: true })?,
    funds: coins(bounty, "uatom"),
};
// The relay's response data contains request_id: store it via a reply handler.

// Delivery: the consumer implements
ExecuteMsg::SedaResult { request_id, exit_code, consensus, result, .. } => {
    require info.sender == RELAY
    require request_id is one of ours
    if !consensus || exit_code != 0 { handle failure }
    else { use result }
}
```

The consumer must check `info.sender` against the relay address. Otherwise anyone could call `SedaResult` with a fake result.

---

## Relayer

Loop:

1. Read `wasm-seda_request` events on the Hub, or poll `Pending`. Skip requests whose bounty does not cover the SEDA fees (`gas_price × (exec_gas_limit + tally_gas_limit)`) plus the Hub gas.
2. Post the request on SEDA: `MsgExecuteContract` to the SEDA core contract, `post_data_request { posted_dr: <exact params, memo included>, seda_payload: "", payback_address: <own Hub address> }`, with the fees attached. Check that the returned `dr_id` equals the relay's.
3. Wait for `tally_completion` with this `dr_id` (websocket on `NewBlock`, reading `finalize_block_events`), with polling of `/seda-chain/batching/data_result/{dr_id}` as a fallback.
4. Pick `H ≥ T`. Query `/store/batching/key` at `H` with `prove=true`, trying `batched=true` then `false`. Convert `ProofOps` with `ConvertProofs`.
5. If the Hub client has no consensus state at `H+1`, build `MsgUpdateClient`: the signed header at `H+1`, plus the validator set at the client's latest trusted height and `trusted_height`.
6. Broadcast `[MsgUpdateClient?, MsgExecuteContract(relay, Submit{…, proof_height: H+1})]` in one transaction.

Steps 4 and 6 are what `demos/seda-verify` already does off-chain. Step 5 is the main new piece: Hermes builds such headers internally but cannot bundle a custom message in the same transaction.

---

## Variant: Price Feed (push)

Request/response does not fit prices: a consumer would wait ~2 minutes for each value. A feed contract instead keeps the latest proven price, and relayers push updates.

### Latency

Measured on mainnet (single sample, data request `f5fd03de…d3ac`):

| Step | Time |
|---|---|
| Relayer posts on SEDA (≈ 8 s/block) | ~8 s |
| Commit, reveal, tally (SEDA blocks 9264961 → 9264974) | ~106 s |
| Proof + header, Hub tx (≈ 5.8 s/block) | ~6–10 s |
| **Total from trigger to delivery** | **≈ 2 min** |

The commit/reveal cycle dominates. That is fine for lending with conservative LTVs, TWAPs and periodic settlement, but not for perps or leveraged trading.

### Feed contract

- Configured with one feed per asset: the expected request parameters **except the memo** (programs, inputs, gas, `min_replication_factor`, consensus filter).
- `Submit` takes the full parameters including the memo. The contract checks every non-memo parameter against the feed config, recomputes `dr_id`, then runs the same proof checks as the relay (key, `VerifyMembership`, decoding).
- Only `consensus=true` and `exit_code=0` results update the price. Older results than the stored one (by `block_timestamp`) are rejected.
- It stores `{ price, block_timestamp, block_height }`. Consumers read it and reject prices older than their own staleness limit.

### Update trigger

Relayers decide **when** to update by watching any price source off-chain. That source only triggers updates. The delivered value always comes from SEDA, so a wrong source can cause useless or missed updates, never a wrong price.

The contract pays the bounty only for useful updates:

```
pay if  |new − stored| / stored ≥ deviation_threshold
    or  new.block_timestamp − stored.block_timestamp ≥ heartbeat
else    accept the update, no bounty
```

- The heartbeat bounds how stale the feed can get if relayers withhold updates. Any relayer can push, so one honest relayer is enough.
- Relayers pay SEDA before they know the result, so they should trigger with a margin above the threshold.
- The threshold reduces cost, not latency.

---

## Security Summary

| Attack | Why it fails |
|---|---|
| Forge a result | `VerifyMembership` against the light client root |
| Post different parameters on SEDA | different `dr_id` → no proof for the expected key |
| Replay an older identical request | memo with `request_id` → unique `dr_id` |
| Point to another IBC client | `client_id` comes from the config only |
| Use a frozen or expired client | `VerifyMembership` requires `Active` |
| Copy a `Submit` from the mempool | bounty goes to the proven `payback_address` |
| Break delivery with a bad consumer | callback with `reply_on_error` and a gas limit |
| Never deliver | `Reclaim` after the timeout |

The oracle's own security (how many executors, which consensus filter) is set by the request parameters. `min_replication_factor` lets the relay enforce a floor.

---

## Open Questions

1. **Stability of the `x/batching` layout.** The key depends on SEDA's internal store. A more robust alternative is to prove the `Batch` (its `data_result_root`) and then the result's inclusion in that Merkle tree. This needs a second, in-contract Merkle check. The question has been sent to SEDA.
2. **Choice of H.** Using `H = T` gives a `batched=false` proof as early as possible. Waiting for batching gives no extra security for this relay.
3. **Bounty pricing.** SEDA fees are paid in SEDA tokens and the bounty in ATOM. A fixed bounty either overpays or leaves requests undelivered. A floor computed from the gas parameters, or a market where relayers simply skip unprofitable requests, should be enough for a first version.
4. **Exclusive window.** With `payback_address`, the first relayer to post on SEDA effectively wins: others would post a duplicate `dr_id`, which SEDA rejects. No extra claim mechanism seems needed. This should be checked on testnet.
5. **SEDA FAST (later).** SEDA FAST executes the same oracle programs off-chain in under a second, and returns a result signed by a single SEDA key. It could be verified today with `secp256k1_verify`, with no Gaia change. The trust model is much more centralized, and access goes through an API key and commercial onboarding. A later version could use FAST for freshness and IBC-proven core results as a circuit breaker. Out of scope for v1.
6. **Clients of other chains.** Nothing here is SEDA-specific except the key layout and the `DataResult` decoding. The same relay pattern works for any chain connected to the Hub over IBC.

---

## References

- [cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023): Whitelist VerifyMembership for CosmWasm gRPC queries
- [`demos/seda-verify`](demos/seda-verify): off-chain mainnet check of the verification
- [`interchain-events-contract-spec.md`](interchain-events-contract-spec.md): proof structure and ProofSpecs
- `sedaprotocol/seda-chain`: `x/batching` (store layout, `DataResult`), `x/tally/keeper/endblock.go` (`tally_completion`)
- `sedaprotocol/seda-chain-contracts`: `common/src/msgs/data_requests/types.rs` (`dr_id`), `contract/src/msgs/data_requests/execute/post_request.rs`
- [Polymarket example program](https://github.com/sedaprotocol/polymarket-example-program): a ready-made oracle program for event outcomes
