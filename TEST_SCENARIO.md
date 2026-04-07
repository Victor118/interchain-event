# Test Scenario: Interchain Events POC

## Deployed Contracts

| Chain | Contract | Code ID | Address |
|---|---|---|---|
| Cosmos Hub (`cosmoshub-4`) | interchain-events v7 | 501 | `cosmos1ul3v2sh4uqgvzr2c00dz2un6373hkunk0e0z9ay9x9td3uj7qdtqqggyqc` |
| Cosmos Hub (`cosmoshub-4`) | proof-callback v2 | 502 | `cosmos108u0auz26aqgulr5exh4h2gadqar7qedcjj9yx7da5ramn0hlnmqj5plp2` |
| Neutron (`neutron-1`) | attestation-registry | 5237 | `neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl` |

### Previous deployments (deprecated)

| Chain | Contract | Code ID | Address |
|---|---|---|---|
| Cosmos Hub (`cosmoshub-4`) | interchain-events v1 | 461 | `cosmos1ukwm6w9gra4cypppqyf8m603w9qg2kamdhhj29quqna6zy5yqcnsuf2vtr` |

## Deployer Addresses

- Hub: `cosmos18q6wqf3qmpqg9naeqfgxqe740m0xgqfpcz2d4m`
- Neutron: `neutron1pc39gs6rqds97erf7h6hnvn6pmvg54awlmdyw5`

## RPC Endpoints

- Hub: `https://cosmos-rpc.polkachu.com:443` or `https://rpc.cosmos.directory/cosmoshub`
- Neutron: `https://rpc-kralum.neutron-1.neutron.org:443`

---

## Step 1: Write an attestation on Neutron

Call the attestation-registry contract on Neutron to write a KYC attestation:

```bash
neutrond tx wasm execute neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl \
  '{"attest":{"id":"cosmos1abc","status":"approved"}}' \
  --from deployer --keyring-backend file \
  --gas auto --gas-adjustment 1.3 --gas-prices 0.01untrn \
  --node https://rpc-kralum.neutron-1.neutron.org:443 \
  --chain-id neutron-1
```

Verify the attestation was written:

```bash
neutrond q wasm contract-state smart neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl \
  '{"get_attestation":{"id":"cosmos1abc"}}' \
  --node https://rpc-kralum.neutron-1.neutron.org:443
```

---

## Step 2: Find the IBC light client ID for Neutron on the Hub

We need the `07-tendermint-X` client ID that the Hub uses to track Neutron:

```bash
gaiad q ibc client states --node https://cosmos-rpc.polkachu.com:443 -o json | \
  jq '.client_states[] | select(.client_state."@type" | contains("tendermint")) | .client_id'
```

To identify which client tracks Neutron, check the chain_id in each client state:

```bash
gaiad q ibc client state 07-tendermint-XXX --node https://cosmos-rpc.polkachu.com:443 -o json | \
  jq '.client_state.chain_id'
```

Look for `chain_id: "neutron-1"`.

---

## Step 3: IAVL key for the attestation (pre-computed)

The attestation is stored in the wasm module's IAVL tree. The key structure is:

```
\x03 + <contract_address_bytes_32> + <cw-storage-plus key>
```

### Pre-computed values

- **Contract address (bech32)**: `neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl`
- **Contract address (hex, 32 bytes)**: `6ddcac1383e59acf9591d7edb6f8257bf872e1bdf916ca77cbff057b658d395d`
- **Namespace**: `attestations` (12 chars)
- **Namespace length prefix (2 bytes BE)**: `000c`
- **Namespace (hex)**: `6174746573746174696f6e73`
- **Map key**: `cosmos1abc`
- **Map key (hex)**: `636f736d6f7331616263`

### Full IAVL key (57 bytes, hex)

```
036ddcac1383e59acf9591d7edb6f8257bf872e1bdf916ca77cbff057b658d395d000c6174746573746174696f6e73636f736d6f7331616263
```

### For abci_query

```
path = "store/wasm/key"
data = 0x036ddcac1383e59acf9591d7edb6f8257bf872e1bdf916ca77cbff057b658d395d000c6174746573746174696f6e73636f736d6f7331616263
```

### For Subscribe

```
key_path[0] = "wasm"   (store name, used for SimpleTree proof level)
key_path[1] = unused   (the actual IAVL key bytes are passed in SubmitProof.key)
```

---

## Step 4: Fetch the Merkle proof from Neutron

Query the state with proof via `abci_query`:

```bash
curl "https://rpc-kralum.neutron-1.neutron.org:443/abci_query?\
path=\"store/wasm/key\"&\
data=0x03<full_iavl_key_hex>&\
prove=true&\
height=<H>"
```

The response contains:
- `response.key`: the key (base64)
- `response.value`: the value (base64) — this is the protobuf-encoded `Attestation` struct
- `response.proofOps.ops[0]`: IAVL proof (`type: "ics23:iavl"`)
- `response.proofOps.ops[1]`: SimpleTree proof (`type: "ics23:simple"`)

**Important**: Note the `height` from the response — the proof is only valid at that specific height.

---

## Step 5: Ensure the light client has a ConsensusState at the proof height

Check if the Hub's light client has a ConsensusState for the proof height:

```bash
gaiad q ibc client consensus-states 07-tendermint-XXX \
  --node https://cosmos-rpc.polkachu.com:443 -o json | \
  jq '.consensus_states[].height'
```

If the proof height is not available, you need to include a `MsgUpdateClient` in the same transaction as `MsgExecuteContract`. This requires fetching the header from Neutron:

```bash
# Fetch commit (signed header) at height H
curl "https://rpc-kralum.neutron-1.neutron.org:443/commit?height=<H>"

# Fetch validators at height H
curl "https://rpc-kralum.neutron-1.neutron.org:443/validators?height=<H>"
```

Then build a `MsgUpdateClient` with the header and include it as the first message in the transaction.

---

## Step 6: Create a subscription on the Hub

Create a subscription that triggers when the attestation status is "approved" on Neutron:

```bash
gaiad tx wasm execute cosmos1ul3v2sh4uqgvzr2c00dz2un6373hkunk0e0z9ay9x9td3uj7qdtqqggyqc \
  '{
    "subscribe": {
      "client_id": "07-tendermint-1119",
      "key_path": ["wasm"],
      "watch_key": "<base64_iavl_key>",
      "condition": {"json_path_equals": {"path": "status", "expected": "approved"}},
      "callback_contract": "cosmos108u0auz26aqgulr5exh4h2gadqar7qedcjj9yx7da5ramn0hlnmqj5plp2",
      "callback_msg": "eyJvbl9wcm9vZl92ZXJpZmllZCI6e319",
      "expires_after_blocks": null
    }
  }' \
  --from deployer --keyring-backend file \
  --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 \
  --chain-id cosmoshub-4
```

### Subscribe parameters

| Parameter | Description |
|---|---|
| `client_id` | IBC light client ID tracking the remote chain (e.g. `07-tendermint-1119` for Neutron) |
| `key_path` | Merkle store name (e.g. `["wasm"]`). Used for the SimpleTree proof level |
| `watch_key` | The exact IAVL key to watch (base64-encoded raw bytes). The contract verifies that the submitted proof matches this key — prevents proving a different key |
| `condition` | Trigger condition: `"exists"`, `{"equals": {"expected": "<base64>"}}`, `{"json_path_equals": {"path": "status", "expected": "approved"}}`, `{"greater_than": {"threshold": "<base64>", "encoding": "numeric"}}`, `{"less_than": ...}` |
| `callback_contract` | Contract address to call when the proof is verified |
| `callback_msg` | Base64-encoded JSON message to send to the callback contract |
| `expires_after_blocks` | Optional expiry in blocks from creation (null = no expiry) |

### watch_key construction

The `watch_key` is the raw IAVL key bytes that identify the state entry on the remote chain. For wasm contract state (cw-storage-plus Map encoding):

```
\x03 + <contract_address_bytes_32> + <2-byte BE namespace length> + <namespace> + <map_key>
```

Example for `attestations::cosmos1abc` in the attestation-registry contract:
```
03 + 6ddcac1383e59acf9591d7edb6f8257bf872e1bdf916ca77cbff057b658d395d + 000c + 6174746573746174696f6e73 + 636f736d6f7331616263
```

The frontend state explorer computes this automatically when creating a subscription.

---

## Step 7: Submit the proof to the Hub

Convert the proof from `abci_query` format (ProofOps) to `MerkleProof` format (two CommitmentProof entries), then submit:

```bash
gaiad tx wasm execute cosmos1ul3v2sh4uqgvzr2c00dz2un6373hkunk0e0z9ay9x9td3uj7qdtqqggyqc \
  '{
    "submit_proof": {
      "subscription_id": 1,
      "height": {
        "revision_number": 2,
        "revision_height": <proof_height>
      },
      "app_hash": "<base64_app_hash>",
      "proof": "<base64_MerkleProof>",
      "key": "<base64_iavl_key>",
      "value": "<base64_value>"
    }
  }' \
  --from deployer --keyring-backend file \
  --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 \
  --chain-id cosmoshub-4
```

### SubmitProof parameters

| Parameter | Description |
|---|---|
| `subscription_id` | ID of the subscription to trigger |
| `height` | Height on the remote chain at which the proof was generated |
| `app_hash` | AppHash (multistore root) at the given height. POC: provided by submitter. Production: read from IBC light client |
| `proof` | Base64-encoded MerkleProof (two CommitmentProofs: IAVL + SimpleTree) |
| `key` | The IAVL key being proven (base64). Must match the subscription's `watch_key` |
| `value` | The value being proven (base64). Condition is evaluated against this value |

### Proof format conversion

The `abci_query` returns `ProofOps` with two `ProofOp` entries. Each `ProofOp.data` is a protobuf-encoded `ics23.CommitmentProof`.

The contract expects a `MerkleProof` (from `ibc.core.commitment.v1`):
```protobuf
message MerkleProof {
  repeated ics23.CommitmentProof proofs = 1;
}
```

So you need to:
1. Extract `ops[0].data` (IAVL CommitmentProof) and `ops[1].data` (SimpleTree CommitmentProof) from the `abci_query` response
2. Wrap them in a `MerkleProof` protobuf message
3. Base64-encode the result

**Note**: Neutron's revision_number is `2` (the chain went through a revision at some point).

---

## Automated Test Script

The `scripts/` directory contains a TypeScript script that automates the full flow:

```bash
docker compose up -d scripts
docker compose exec scripts npm install

# Full flow (write attestation + subscribe + prove + verify callback):
docker compose exec \
  -e MNEMONIC_HUB="..." \
  -e MNEMONIC_NEUTRON="..." \
  scripts npx tsx test-flow.ts

# Submit proof for an existing subscription:
docker compose exec \
  -e MNEMONIC_HUB="..." \
  scripts npx tsx test-flow.ts --submit-proof --subscription-id=1

# Read-only query:
docker compose exec scripts npx tsx test-flow.ts --query-only
```

---

## Key Challenges

1. **IAVL key construction**: Must exactly match cw-storage-plus encoding (namespace length prefix + namespace + key)
2. **Proof format**: Converting from `tendermint.crypto.ProofOps` to `ibc.core.commitment.v1.MerkleProof`
3. **AppHash source**: The Hub disables gRPC/Stargate queries for CosmWasm. The POC passes app_hash as parameter. Production would use `VerifyMembership` (see [cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023))
4. **Neutron revision_number**: Neutron uses revision_number `2` (not `1`)

## Quick Verification

Query existing subscriptions and callback events:

```bash
# Query a subscription
gaiad q wasm contract-state smart cosmos1ul3v2sh4uqgvzr2c00dz2un6373hkunk0e0z9ay9x9td3uj7qdtqqggyqc \
  '{"subscription":{"id":1}}' \
  --node https://cosmos-rpc.polkachu.com:443

# Query proof-callback events
gaiad q wasm contract-state smart cosmos108u0auz26aqgulr5exh4h2gadqar7qedcjj9yx7da5ramn0hlnmqj5plp2 \
  '{"events":{}}' \
  --node https://cosmos-rpc.polkachu.com:443
```
