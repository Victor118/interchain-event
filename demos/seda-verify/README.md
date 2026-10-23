# seda-verify

Off-chain, read-only check that a [SEDA](https://www.seda.xyz/) oracle data result can be proven against
the Cosmos Hub's IBC light client of `seda-1` (`07-tendermint-1372`), using mainnet data.

It replays exactly what the Hub runs for `/ibc.core.client.v1.Query/VerifyMembership`
(`07-tendermint` `verifyMembership` in ibc-go v10):

```go
merkleProof.VerifyMembership(clientState.ProofSpecs, consensusState.Root, merklePath, value)
```

- **Trusted root**: the client state and the latest consensus state are read from the Hub.
- **Proof and value**: read from SEDA with `abci_query` (`prove=true`) at the height matching that consensus state.

Once [cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023) lands, a CosmWasm contract on the Hub can run
this same verification with a single `VerifyMembership` gRPC query. That would make it possible to relay SEDA
oracle results to the Hub trustlessly, with no SEDA deployment on the Hub.

## Run

```bash
go run .                          # uses a known mainnet data request
go run . -dr-id <data request id> # any data result stored on seda-1
```

Flags: `-hub-grpc`, `-client-id`, `-seda-rpc`, `-seda-rest`, `-dr-id` (see `go run . -h`). No wallet, no transaction.

## What it checks

1. The Hub client of `seda-1` is `Active`, which is also checked by `VerifyMembership` itself.
2. It takes the latest consensus state stored by the Hub, at height `H+1`. The Hub only stores consensus states at
   heights where a relayer updated the client.
3. It builds the `x/batching` key of the data result, by hand and cross-checked against SEDA's `collections` encoding:
   ```
   0x00 (DataResultsPrefix) | batched (1 byte) | dr_id + 0x00 | dr_block_height (8 bytes BE)
   ```
   A result is first stored under `batched=false`, then moved to `batched=true` once it is included in a batch.
   The demo uses whichever key exists at height `H`.
4. It fetches the value and proof from SEDA at height `H`. A proof at `H` verifies against the app hash in the
   header of block `H+1`.
5. It verifies the proof with the client's proof specs and the consensus state root.
6. It runs negative checks, which must fail: a tampered value, and the other `batched` key.

## Example output

```
→ Hub client 07-tendermint-1372 status: Active
→ Hub consensus state of seda-1 at height 1-9620063: root 1BF64345199D2E86E0926CFE2C25F454DF72129929A96B10222B40FD0C6FC53E (2026-10-23T17:53:23Z)
→ Data request f5fd03de0637abee041dbf3bc2e23a8252ee81002c05ed5ea6729e6c2e89d3ac submitted at SEDA height 9264961
→ SEDA key at height 9620062 (batched=true): 0001663566643033646530363337616265653034316462663362633265323361383235326565383130303263303565643565613637323965366332653839643361630000000000008D5F41
   Proven DataResult:
     id               "4d80e3a9a870a003ca6eb757b3863b3e7d11a1152cdb141f8bc959ba09d25749"
     dr_id            "f5fd03de0637abee041dbf3bc2e23a8252ee81002c05ed5ea6729e6c2e89d3ac"
     dr_block_height  9264961
     version          "0.0.1"
     block_height     9264974
     block_timestamp  1789891339
     exit_code        254
     result           "consensus in error"
     consensus        1

✅ VerifyMembership succeeded: the Hub's light client of seda-1 proves this data result.

✅ tampered value rejected as expected
✅ key with batched=false rejected as expected
```

The default data request is not a successful oracle answer (`exit_code` 254). In the batches sampled while building
this demo, no mainnet data result had `exit_code` 0. The proof mechanism is the same for any stored result.

## Caveats

- The demo depends on SEDA's internal `x/batching` store layout, which is not a public API. A SEDA upgrade that
  changes it would require updating the key construction.
- The Hub client must stay `Active`. Today it is updated by relayers, and anyone can submit `MsgUpdateClient`.
