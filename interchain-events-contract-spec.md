# Interchain Events — Technical Specification for POC

## Objective

Build a CosmWasm smart contract on the Cosmos Hub that can **verify the state of a remote chain** by performing ICS-23 Merkle proof verification in pure Wasm, using the IBC light client's ConsensusState as the trusted root.

This is the foundational primitive for the "Interchain Events" product — a cross-chain event subscription service where chains can subscribe to state changes on other chains and react automatically.

---

## Architecture Overview

```
Remote Chain (e.g., Neutron)          Cosmos Hub
┌──────────────────────┐       ┌─────────────────────────────┐
│                      │       │                             │
│  CosmWasm contract   │       │  IBC Light Client           │
│  with state:         │       │  (07-tendermint-X)          │
│  kyc/0xABC = true    │       │  stores ConsensusState:     │
│                      │       │    - root (AppHash)         │
│  RPC exposes:        │       │    - timestamp              │
│  abci_query with     │       │    - next_validators_hash   │
│  prove=true          │       │                             │
│                      │       │  Interchain Events Contract │
│                      │       │  (CosmWasm)                 │
│                      │       │    1. Query ConsensusState   │
│                      │       │    2. Extract root (AppHash)│
│                      │       │    3. Verify ICS-23 proof   │
│                      │       │    4. Execute action         │
└──────────────────────┘       └─────────────────────────────┘
         │                                    ▲
         │  Watcher/User fetches proof        │
         │  via RPC and submits to Hub        │
         └────────────────────────────────────┘
```

---

## Key Technical Findings

### 1. ConsensusState is queryable from CosmWasm

Gaia's Stargate query whitelist (app/keepers/keepers.go:312-324) includes:

- `/ibc.core.client.v1.Query/ClientState` ✅
- `/ibc.core.client.v1.Query/ConsensusState` ✅
- `/ibc.core.connection.v1.Query/Connection` ✅

**VerifyMembership is NOT whitelisted** — it's not even exposed as a gRPC query on Gaia. It's an internal method of the ClientState interface used by the IBC module.

**Solution**: Query the ConsensusState to get the root hash (AppHash), then perform ICS-23 proof verification in pure Rust/Wasm inside the contract.

### 2. Proof structure is two-level

The AppHash stored in the ConsensusState is the **multistore root** (SimpleMerkleTree of all module roots), NOT a single IAVL tree root.

When querying a remote chain with `abci_query?prove=true`, the response contains a `ProofOps` with **two** `ProofOp` entries:

1. **IAVL proof** — proves the key/value exists in the specific module's IAVL tree (e.g., the `wasm` module)
2. **SimpleTree proof (multistore)** — proves the module's IAVL root is included in the AppHash

The contract must verify both proofs in sequence:

```
AppHash (from ConsensusState)
    ↓ verify SimpleTree proof → yields module root
Module IAVL root
    ↓ verify IAVL proof → yields key/value
```

### 3. ICS-23 crate exists in Rust

The `ics23` crate (v0.12.0) on crates.io provides:

- `CommitmentProof` struct (ExistenceProof, NonExistenceProof, BatchProof, CompressedBatchProof)
- `ProofSpec` struct (defines tree format: leaf spec, inner spec, depths)
- `ExistenceProof.verify()` method on the ExistenceProof
- `calculate_existence_root()` function
- `HostFunctionsProvider` trait for delegating hash functions

The Go equivalent signature is:
```go
func VerifyMembership(spec *ProofSpec, root CommitmentRoot, proof *CommitmentProof, key []byte, value []byte) bool
```

**Important**: The Rust crate uses a `HostFunctionsProvider` trait for SHA256 and other hash operations. In a CosmWasm context, either:
- Use the default `HostFunctionsManager` provided by the crate (if it compiles to Wasm)
- Implement the trait using `cosmwasm_std::Api` or the `sha2` crate

### 4. ProofSpec constants for Cosmos SDK

For Cosmos SDK chains using IAVL + multistore, there are two standard ProofSpecs:

**IAVL ProofSpec** (for the module sub-tree):
```
leaf_spec: {
    hash: SHA256,
    prehash_key: NO_HASH,
    prehash_value: SHA256,
    length: VAR_PROTO,
    prefix: [0x00]
}
inner_spec: {
    child_order: [0, 1],
    child_size: 33,
    min_prefix_length: 4,
    max_prefix_length: 12,
    hash: SHA256
}
```

**SimpleTree ProofSpec** (for the multistore):
```
leaf_spec: {
    hash: SHA256,
    prehash_key: NO_HASH,
    prehash_value: SHA256,
    length: VAR_PROTO,
    prefix: [0x00]
}
inner_spec: {
    child_order: [0, 1],
    child_size: 32,
    min_prefix_length: 1,
    max_prefix_length: 1,
    hash: SHA256
}
```

These specs are defined in `ibc-go/modules/light-clients/07-tendermint/consensus_state.go` and in the `ibc` Rust crate as `cosmos_specs()`.

### 5. Gaia versions (v27)

From go.mod:
- wasmd: v0.60.1
- ibc-go: v10.3.0
- Cosmos SDK: v0.53.4
- CometBFT: v0.38.19
- 08-wasm: v10.3.0

CosmWasm on Hub is **permissionless** (proposal 1007, August 2025).

---

## Contract Design

### Messages

```rust
#[cw_serde]
pub enum ExecuteMsg {
    // Register a new subscription
    Subscribe {
        client_id: String,              // e.g., "07-tendermint-42" (Neutron on Hub)
        key_path: Vec<String>,          // e.g., ["wasm", "\x03<contract_addr><storage_key>"]
        expected_value: Option<Binary>, // if set, verify exact match
        action: StoredAction,           // what to do when verified
    },

    // Submit a proof to trigger a subscription
    SubmitProof {
        subscription_id: u64,
        height: Height,                 // revision_number + revision_height
        proof: Binary,                  // protobuf-encoded MerkleProof (two CommitmentProofs)
        key: Binary,                    // the key being proven
        value: Binary,                  // the value being proven
    },

    // Submit dual proof for change detection
    SubmitDualProof {
        subscription_id: u64,
        height_before: Height,
        proof_before: Binary,
        value_before: Binary,
        height_after: Height,
        proof_after: Binary,
        value_after: Binary,
        key: Binary,
    },
}

#[cw_serde]
pub enum QueryMsg {
    // Get subscription details
    Subscription { id: u64 },
    // List active subscriptions
    ListSubscriptions { start_after: Option<u64>, limit: Option<u32> },
}
```

### StoredAction

Actions are stored as raw protobuf messages, making the contract agnostic to action type:

```rust
#[cw_serde]
pub struct StoredAction {
    pub type_url: String,   // e.g., "/cosmos.bank.v1beta1.MsgSend"
    pub value: Binary,      // protobuf-encoded message bytes
}
```

At execution time, the contract emits:
```rust
CosmosMsg::Stargate {
    type_url: action.type_url,
    value: action.value,
}
```

This supports any Cosmos message: MsgSend, MsgExecuteContract, ICA MsgSendTx, ICS-20 MsgTransfer, etc.

### Core Verification Logic

```rust
fn verify_proof(
    deps: Deps,
    client_id: &str,
    height: &Height,
    proof_bytes: &[u8],
    key_path: &[String],  // ["wasm", "<hex_key>"]
    value: &[u8],
) -> Result<bool, ContractError> {

    // Step 1: Query ConsensusState via Stargate (whitelisted)
    let consensus_state_response = deps.querier.query::<Binary>(
        &QueryRequest::Stargate {
            path: "/ibc.core.client.v1.Query/ConsensusState".to_string(),
            data: encode_consensus_state_request(client_id, height),
        }
    )?;

    // Step 2: Decode ConsensusState, extract root (AppHash)
    let consensus_state = decode_tendermint_consensus_state(&consensus_state_response)?;
    let app_hash = consensus_state.root; // This is the multistore root

    // Step 3: Decode the MerkleProof (contains two CommitmentProofs)
    let merkle_proof = decode_merkle_proof(proof_bytes)?;
    // merkle_proof.proofs[0] = IAVL proof (module level)
    // merkle_proof.proofs[1] = SimpleTree proof (multistore level)

    // Step 4: Verify SimpleTree proof (multistore → module root)
    // The SimpleTree proof proves that the module's IAVL root
    // is included in the AppHash
    let simple_tree_spec = simple_tree_proof_spec();
    let iavl_spec = iavl_proof_spec();

    // Step 5: Verify IAVL proof (module root → key/value)
    // The IAVL proof proves that the key/value exists in the module's tree

    // The verification must chain:
    // verify proof[0] (IAVL) against intermediate root
    // verify proof[1] (SimpleTree) against AppHash
    // Ensure the intermediate root from proof[0] matches what proof[1] proves

    // Use ics23 crate functions for each level
    let valid = verify_chained_membership_proof(
        &app_hash,
        &merkle_proof,
        &[iavl_spec, simple_tree_spec],
        key_path,
        value,
    )?;

    Ok(valid)
}
```

### Important: MerkleProof structure

The proof from `abci_query` is a `tendermint.crypto.ProofOps` containing multiple `ProofOp`:

```protobuf
message ProofOps {
  repeated ProofOp ops = 1;
}

message ProofOp {
  string type = 1;   // "ics23:iavl" or "ics23:simple"
  bytes key = 2;
  bytes data = 3;    // protobuf-encoded CommitmentProof
}
```

The contract receives this as bytes, decodes it, and processes each level.

In ibc-go, the `MerkleProof` type wraps this:
```protobuf
// from ibc-go/modules/core/23-commitment/types/merkle.proto
message MerkleProof {
  repeated ics23.CommitmentProof proofs = 1;
}
```

---

## Proof Generation (Client/Watcher Side)

### Fetching a proof from a remote chain

```bash
# Query the state of a CosmWasm contract on Neutron with proof
curl "http://neutron-rpc:26657/abci_query?\
path=\"store/wasm/key\"&\
data=0x03<contract_addr_hex><storage_key_hex>&\
prove=true&\
height=<H>"
```

The response contains:
```json
{
  "response": {
    "key": "<base64_key>",
    "value": "<base64_value>",
    "height": "12345",
    "proofOps": {
      "ops": [
        {
          "type": "ics23:iavl",
          "key": "<base64>",
          "data": "<base64_CommitmentProof>"
        },
        {
          "type": "ics23:simple",
          "key": "<base64>",
          "data": "<base64_CommitmentProof>"
        }
      ]
    }
  }
}
```

### CosmWasm contract state key construction

For a CosmWasm contract using cw-storage-plus:

```rust
// In the contract on remote chain
const KYC_STATUS: Map<&str, bool> = Map::new("kyc");
KYC_STATUS.save(deps.storage, "cosmos1abc", &true)?;
```

The key in the IAVL tree for module `wasm` is:
```
\x03 + <contract_address_bytes_20> + "kyc" + <key_bytes>
```

The `\x03` prefix is the wasmd contract state prefix. The contract address is 20 bytes (decoded bech32). The storage key is the cw-storage-plus namespace + the map key.

For the `abci_query`, the `path` is `"store/wasm/key"` and `data` is the hex-encoded full key.

### MsgUpdateClient

The watcher/user must ensure the light client on the Hub has a ConsensusState for the proof's height. If not, they include a `MsgUpdateClient` in the same transaction:

```
Transaction:
  Message 1: MsgUpdateClient {
    client_id: "07-tendermint-42",
    client_message: <Header from remote chain at height H>
  }
  Message 2: MsgExecuteContract {
    contract: <interchain_events_contract>,
    msg: SubmitProof { ... height: H, proof: ... }
  }
```

The header is fetched from the remote chain's RPC:
```bash
# Fetch signed header
curl "http://neutron-rpc:26657/commit?height=<H>"
# Fetch validators
curl "http://neutron-rpc:26657/validators?height=<H>"
```

Both messages are atomic — if the UpdateClient fails, the proof is not processed.

---

## Subscription Types

### One-shot subscription

Triggered once, consumed after execution.

```rust
pub struct Subscription {
    pub id: u64,
    pub client_id: String,
    pub key_path: Vec<String>,
    pub condition: Condition,
    pub action: StoredAction,
    pub status: SubscriptionStatus,  // Active, Triggered, Expired
    pub created_at: Timestamp,
    pub expires_at: Option<Timestamp>,
}

pub enum Condition {
    // Value equals expected
    Equals { expected: Binary },
    // Value exists (any value)
    Exists,
    // Value does not exist (uses VerifyNonMembership)
    NotExists,
}
```

### Streaming subscription

Monitors an incrementing index, fires on each new item.

```rust
pub struct StreamingSubscription {
    pub id: u64,
    pub client_id: String,
    pub key_prefix: String,         // e.g., "settlements/"
    pub last_processed_index: u64,  // starts at 0
    pub action: StoredAction,       // executed for each new item
    pub status: SubscriptionStatus,
}
```

The watcher submits a proof for `key_prefix + (last_processed_index + 1)`. If it exists, the contract executes the action and increments the index.

### Dual-proof subscription (change detection)

For detecting threshold crossings or state transitions.

```rust
pub struct DualProofSubscription {
    pub id: u64,
    pub client_id: String,
    pub key_path: Vec<String>,
    pub condition: DualCondition,
    pub action: StoredAction,
    pub last_verified_height: Option<Height>,
}

pub enum DualCondition {
    // Value changed from anything to expected
    ChangedTo { expected: Binary },
    // Value crossed a threshold (encoded as comparison)
    ThresholdCrossed {
        threshold: Binary,      // threshold value
        direction: Direction,   // Above or Below
    },
}
```

The submitter provides proofs at height H-1 and H. The contract verifies:
- At H-1: condition NOT met
- At H: condition met
- H > last_verified_height (anti-replay)

---

## Dependencies

### Rust crates for the contract

```toml
[dependencies]
cosmwasm-std = { version = "2.1", features = ["stargate"] }
cosmwasm-schema = "2.1"
cw-storage-plus = "2.0"
serde = { version = "1.0", default-features = false, features = ["derive"] }
ics23 = "0.12"          # ICS-23 proof verification
prost = "0.13"           # protobuf decoding
sha2 = "0.10"            # SHA256 for HostFunctionsProvider if needed
```

**Critical**: Verify that the `ics23` crate compiles to `wasm32-unknown-unknown` target. The `HostFunctionsProvider` trait may need a custom implementation for the Wasm target.

### Protobuf types needed

The contract needs to decode:
- `ibc.core.client.v1.QueryConsensusStateResponse`
- `ibc.lightclients.tendermint.v1.ConsensusState`
- `ibc.core.commitment.v1.MerkleProof`
- `ics23.CommitmentProof`
- `ics23.ExistenceProof`

These can be defined manually in the contract or imported from `cosmos-sdk-proto` / `ibc-proto` crates (verify Wasm compatibility).

---

## POC Scope — Phase 1

### What to build

1. **Contract**: CosmWasm contract with:
   - `Subscribe` message (one-shot only for POC)
   - `SubmitProof` message with full two-level ICS-23 verification
   - Action execution via `CosmosMsg::Stargate`

2. **Script**: TypeScript/Python script that:
   - Queries a remote chain's contract state with proof
   - Constructs the `MsgUpdateClient` + `MsgExecuteContract` transaction
   - Submits to the Hub

### What NOT to build (yet)

- Streaming subscriptions (Phase 2)
- Dual-proof change detection (Phase 2)
- ICA integration (Phase 2)
- Watcher service (Phase 2)
- Frontend / State Explorer (Phase 3)

### Test scenario

1. Deploy a simple "KYC registry" contract on a testnet chain (Neutron testnet or local chain)
2. The KYC contract stores: `Map<String, bool>` mapping addresses to KYC status
3. Deploy the Interchain Events contract on Hub testnet
4. Create a subscription: "when kyc/cosmos1abc = true on Neutron, send 1 ATOM to cosmos1abc"
5. Approve KYC on Neutron: set `kyc/cosmos1abc = true`
6. Run the script: fetch the proof from Neutron, submit to Hub
7. Verify: the Interchain Events contract verifies the proof and executes the action

### Success criteria

- The contract successfully queries the ConsensusState via Stargate
- The contract successfully verifies a two-level ICS-23 Merkle proof
- The contract executes the stored action upon successful verification
- Gas consumption is within acceptable limits (< 500k SDK gas)

---

## Known Risks and Open Questions

1. **ics23 crate Wasm compatibility**: The `HostFunctionsProvider` trait requires SHA256 implementation. Need to verify this works in `wasm32-unknown-unknown` target.

2. **Gas consumption**: Two-level proof verification with ~30 SHA256 hashes in Wasm. Estimated ~20-40k SDK gas for verification alone, but needs measurement.

3. **Protobuf decoding in Wasm**: The ConsensusState response from Stargate query is protobuf-encoded. Need either `prost` or manual decoding. `prost` adds binary size to the contract.

4. **Proof format compatibility**: The `abci_query` ProofOps format must match what `ics23` crate expects as `CommitmentProof`. May need conversion between `tendermint.crypto.ProofOp` and `ics23.CommitmentProof`.

5. **Key encoding**: The exact encoding of CosmWasm storage keys (namespace prefixes, length prefixes from cw-storage-plus) must be replicated precisely to construct the correct `abci_query` data parameter.

6. **ConsensusState freshness**: The proof height must correspond to an existing ConsensusState in the light client. If not, the submitter must include `MsgUpdateClient` in the transaction.

---

## References

- ics23 Rust crate: https://crates.io/crates/ics23 (v0.12.0)
- ics23 repository: https://github.com/cosmos/ics23
- ibc-go VerifyMembership: https://github.com/cosmos/ibc-go/blob/main/modules/light-clients/07-tendermint/light_client_module.go
- Gaia go.mod (v27): https://github.com/cosmos/gaia/blob/main/go.mod
- CometBFT abci_query: https://docs.cometbft.com/v0.38/rpc/#/ABCI/abci_query
- Cosmos SDK store specification: https://docs.cosmos.network/v0.50/build/spec/store
- ICS-23 specification: https://github.com/cosmos/ibc/blob/main/spec/core/ics-023-vector-commitments/README.md
- wasmd contract state: https://github.com/CosmWasm/wasmd/blob/main/x/wasm/keeper/query_plugins.go
- Interchain Events Business Proposal: ./INTERCHAIN_EVENTS_BUSINESS_PROPOSAL.md
