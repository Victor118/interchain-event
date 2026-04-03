# Test Scenario: Interchain Events POC

## Deployed Contracts

| Chain | Contract | Code ID | Address |
|---|---|---|---|
| Cosmos Hub (`cosmoshub-4`) | interchain-events v2 | 476 | `cosmos13mwx9yrcs9ccns78h6dpl5u5jlutu24vsngzu7y7sjgm77cwjdqsktmyxq` |
| Cosmos Hub (`cosmoshub-4`) | proof-callback | 477 | `cosmos1ej8k44crydrg5qx3jd2g49va6k05mzfq7hfn0zpklqupvnu8nfwsm0ev57` |
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

Create a subscription that triggers when the attestation exists on Neutron:

```bash
gaiad tx wasm execute cosmos1ukwm6w9gra4cypppqyf8m603w9qg2kamdhhj29quqna6zy5yqcnsuf2vtr \
  '{
    "subscribe": {
      "client_id": "07-tendermint-XXX",
      "key_path": ["wasm", "<raw_iavl_key_as_string>"],
      "expected_value": "<base64_encoded_attestation_value>",
      "action": {
        "type_url": "/cosmos.bank.v1beta1.MsgSend",
        "value": "<base64_protobuf_encoded_MsgSend>"
      }
    }
  }' \
  --from deployer --keyring-backend file \
  --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 \
  --chain-id cosmoshub-4
```

### Action encoding

The `action` is a raw protobuf message. For a simple `MsgSend`:

```protobuf
// /cosmos.bank.v1beta1.MsgSend
message MsgSend {
  string from_address = 1;  // the interchain-events contract address
  string to_address = 2;    // recipient
  repeated Coin amount = 3;
}
```

The `from_address` must be the interchain-events contract address (it executes the message). The contract needs to hold funds for this to work.

For testing, a simpler action could be a `MsgExecuteContract` that calls another contract, or even just using `Exists` condition without `expected_value` to verify the proof mechanism works.

---

## Step 7: Submit the proof to the Hub

Convert the proof from `abci_query` format (ProofOps) to `MerkleProof` format (two CommitmentProof entries), then submit:

```bash
gaiad tx wasm execute cosmos1ukwm6w9gra4cypppqyf8m603w9qg2kamdhhj29quqna6zy5yqcnsuf2vtr \
  '{
    "submit_proof": {
      "subscription_id": 1,
      "height": {
        "revision_number": 2,
        "revision_height": <proof_height>
      },
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

## Recommended: Build a Script

Steps 4-7 involve significant protobuf encoding/decoding and are best handled by a script. A TypeScript or Python script should:

1. Query the attestation state on Neutron with `abci_query?prove=true`
2. Parse the ProofOps response
3. Build the MerkleProof protobuf
4. Optionally build a MsgUpdateClient if the ConsensusState is missing
5. Build and submit the SubmitProof transaction to the Hub

Libraries needed:
- **TypeScript**: `@cosmjs/stargate`, `@cosmjs/tendermint-rpc`, `cosmjs-types`, `protobufjs`
- **Python**: `cosmpy`, `grpcio`, `protobuf`

---

## Key Challenges

1. **IAVL key construction**: Must exactly match cw-storage-plus encoding (namespace length prefix + namespace + key)
2. **Proof format**: Converting from `tendermint.crypto.ProofOps` to `ibc.core.commitment.v1.MerkleProof`
3. **ConsensusState availability**: The light client must have a ConsensusState at the exact proof height, otherwise a `MsgUpdateClient` is needed
4. **Action execution**: The contract address is the sender of the action message, so it must have the necessary permissions/funds
5. **Neutron revision_number**: Neutron uses revision_number `2` (not `1`)

## Simpler First Test

Before the full flow, verify the subscription mechanism works by creating a subscription and checking it:

```bash
# Create a simple subscription
gaiad tx wasm execute cosmos1ukwm6w9gra4cypppqyf8m603w9qg2kamdhhj29quqna6zy5yqcnsuf2vtr \
  '{"subscribe":{"client_id":"07-tendermint-0","key_path":["wasm","test"],"expected_value":null,"action":{"type_url":"/cosmos.bank.v1beta1.MsgSend","value":"dGVzdA=="}}}' \
  --from deployer --keyring-backend file \
  --gas auto --gas-adjustment 1.3 --gas-prices 0.005uatom \
  --node https://cosmos-rpc.polkachu.com:443 \
  --chain-id cosmoshub-4

# Query the subscription
gaiad q wasm contract-state smart cosmos1ukwm6w9gra4cypppqyf8m603w9qg2kamdhhj29quqna6zy5yqcnsuf2vtr \
  '{"subscription":{"id":1}}' \
  --node https://cosmos-rpc.polkachu.com:443
```
