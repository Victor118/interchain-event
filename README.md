# Interchain Events

Cross-chain state verification for Cosmos. Subscribe to state changes on any IBC-connected chain, verify them with ICS-23 Merkle proofs, and trigger smart contract callbacks automatically.

## What it does

A smart contract on Chain A subscribes to a state key on Chain B. When the condition is met, a watcher submits a Merkle proof. The contract verifies the proof cryptographically and calls back the subscriber.

```
Chain B: attestation status = "approved"
         ↓ watcher detects
Hub:     interchain-events verifies ICS-23 proof
         ↓ condition met
Hub:     callback contract executes business logic
```

No oracle. No trusted third party. The proof is either mathematically valid or rejected.

## Key properties

- **Unilateral observation** — Watch any chain's state without deploying anything on that chain
- **Zero idle cost** — Verification happens off-chain. On-chain gas only when the condition is actually met
- **Conditional triggers** — `exists`, `equals`, `json_path_equals`, `greater_than`, `less_than`
- **Callback pattern** — Proof verification triggers an arbitrary smart contract call
- **Multi-hop routing** — Chain A can verify Chain C's state through Chain B, via subscription chaining

## Architecture

```
┌─────────────────────────────────────┐
│           Cosmos Hub (CosmWasm)      │
│                                     │
│  ┌───────────────────┐              │
│  │ interchain-events │──callback──→ │  subscriber contract
│  │   • subscriptions │              │  (proof-callback, escrow,
│  │   • ICS-23 verify │              │   compliance gate, ...)
│  │   • conditions    │              │
│  └───────────────────┘              │
│           ↑                         │
└───────────│─────────────────────────┘
            │ submit proof
            │
      ┌─────┴─────┐
      │  Watcher   │  off-chain
      │  (or self- │  • monitors remote chain via RPC/WebSocket
      │   service) │  • fetches Merkle proof when condition met
      └─────┬─────┘  • submits proof + triggers callback
            │
            │ read state + proof
            ↓
┌─────────────────────────────────────┐
│         Remote chain (e.g. Neutron)  │
│                                     │
│  ┌───────────────────┐              │
│  │ any contract or   │              │
│  │ module state      │  ← no changes needed
│  │ (bank, wasm, ...) │
│  └───────────────────┘              │
└─────────────────────────────────────┘
```

## POC status

**Working end-to-end on Cosmos Hub mainnet.**

The POC demonstrates:
- Writing an attestation on Neutron
- Creating a subscription with `json_path_equals` condition on the Hub
- Fetching an ICS-23 Merkle proof from Neutron (IAVL + SimpleTree)
- Verifying the proof on-chain and extracting a JSON field from the proven value
- Triggering a callback on a separate contract

**Current limitation:** The Hub disables Stargate/gRPC queries for CosmWasm, so the AppHash is provided off-chain instead of being read from the IBC light client. The Merkle proof verification itself is fully on-chain and trustless. Enabling `VerifyMembership` for CosmWasm (a 2-line config change in Gaia) would make the entire flow trustless.

### Deployed contracts

| Chain | Contract | Code ID | Address |
|---|---|---|---|
| Cosmos Hub | interchain-events v6 | 481 | `cosmos1e96r45we8w204g5hnh3phlft9szxzkhjqqrf6lu82c5hdfxdz66q52cqg0` |
| Cosmos Hub | proof-callback | 477 | `cosmos1ej8k44crydrg5qx3jd2g49va6k05mzfq7hfn0zpklqupvnu8nfwsm0ev57` |
| Neutron | attestation-registry | 5237 | `neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl` |

## Project structure

```
contracts/
  interchain-events/     Main contract: subscriptions, proof verification, callbacks
  attestation-registry/  Test data source on Neutron
  proof-callback/        Minimal callback receiver for testing
packages/
  shared/                Shared types (conditions, subscriptions, heights)
scripts/                 TypeScript test automation (fetch proofs, submit, verify)
frontend/                Nuxt 4 state explorer + subscription UI
```

## Quick start

### Prerequisites

- Docker + Docker Compose
- Keplr wallet (for frontend interactions)

### Build contracts

```bash
docker compose up -d dev
docker compose exec dev cargo build --release --target wasm32-unknown-unknown
docker compose exec dev bash -c "wasm-opt -Oz target/wasm32-unknown-unknown/release/interchain_events.wasm -o target/wasm32-unknown-unknown/release/interchain_events_opt.wasm"
```

### Run tests

```bash
docker compose exec dev cargo test
```

### Run the test flow script

```bash
docker compose up -d scripts
docker compose exec scripts npm install

# Query existing state (read-only):
docker compose exec scripts npx tsx test-flow.ts --query-only

# Full flow (requires mnemonics with funds on Hub + Neutron):
docker compose exec \
  -e MNEMONIC_HUB="..." \
  -e MNEMONIC_NEUTRON="..." \
  scripts npx tsx test-flow.ts
```

### Run the frontend

```bash
docker compose up -d frontend
# Open http://localhost:3000
```

The state explorer lets you browse any chain's state, click on a key to create a subscription, and sign transactions via Keplr.

## Subscription conditions

| Condition | Description | Example |
|---|---|---|
| `exists` | Key exists in remote state | KYC record created |
| `equals` | Value matches exactly (raw bytes) | Settlement status = finalized |
| `json_path_equals` | JSON field matches | `.status == "approved"` |
| `greater_than` | Numeric/string comparison | Balance > 1000000 |
| `less_than` | Numeric/string comparison | Collateral ratio < 150 |

## How proof verification works

1. **Watcher** detects the condition is met on the remote chain
2. **Watcher** fetches the state with proof via `abci_query?prove=true`
3. The proof contains two ICS-23 `CommitmentProof`s:
   - **IAVL proof**: proves the key/value exists in the module's Merkle tree
   - **SimpleTree proof**: proves the module's root is in the AppHash
4. **Contract** verifies both proofs against the AppHash
5. **Contract** checks the subscription condition against the proven value
6. **Contract** calls the callback contract via `SubMsg`

## Path to trustless

The POC uses an off-chain AppHash because the Hub doesn't expose IBC light client queries to CosmWasm. Two paths to full trustlessness:

**Option A — Whitelist VerifyMembership (recommended)**

Add 2 lines to Gaia's wasmd configuration to allow CosmWasm contracts to call `VerifyMembership` on IBC light clients. This is a read-only query with zero security risk. Requires a Gaia software upgrade governance proposal. See [cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023).

```go
"/ibc.core.client.v1.Query/VerifyMembership":    &ibcclienttypes.QueryVerifyMembershipResponse{},
"/ibc.core.client.v1.Query/VerifyNonMembership": &ibcclienttypes.QueryVerifyMembershipResponse{},
```

**Option B — Embedded Tendermint light client**

The contract maintains its own light client, updated by watchers who submit signed block headers. Makes the protocol fully autonomous and deployable on any CosmWasm chain, but adds complexity and maintenance burden.

## Documentation

- [Whitepaper](interchain-events-contract.md) — Full product description, use cases, revenue model
- [Technical spec](interchain-events-contract-spec.md) — ConsensusState queries, proof structure, ICS-23 verification
- [Test scenario](TEST_SCENARIO.md) — Step-by-step deployment and testing guide
