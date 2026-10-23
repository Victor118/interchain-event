# grpc-query-proxy

Test contract used by Gaia's interchain test suite
(`tests/interchain/delegator/cosmwasm_ibc_test.go`, [cosmos/gaia#4023](https://github.com/cosmos/gaia/issues/4023))
to exercise the IBC light client queries from CosmWasm.

It forwards a raw, protobuf-encoded gRPC query to the chain and returns the raw protobuf response:

```json
{"grpc": {"path": "/ibc.core.client.v1.Query/VerifyMembership", "data": "<base64 protobuf request>"}}
```

The response is the base64-encoded protobuf response. Encoding and decoding happen in the Go test.
The chain's gRPC accept list still decides which paths are reachable: anything else is rejected.

Note: it uses `deps.querier.query_grpc` (feature `cosmwasm_2_0`). `deps.querier.query::<T>()` would try to
parse the protobuf response as JSON and fail.

## Build

The crate is excluded from the root workspace and built with its own `Cargo.lock`, so the output is reproducible:

```bash
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source=grpc_query_proxy_cache,target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/optimizer:0.17.0
```

Expected checksum (the binary committed in Gaia as `testdata/grpc_query_proxy.wasm`):

```
1ff5c8aed3bbdd5e778b8d47bf4c80ebf67cfb95812bb11385c15a5b31cf8698  grpc_query_proxy.wasm
```
