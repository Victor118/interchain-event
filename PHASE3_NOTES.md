# Phase 3 — State Explorer Frontend

## Concept

A web-based visual explorer that lets users navigate the IAVL state tree of any Cosmos chain, browse module data, and create interchain event subscriptions directly from the UI.

Think of it as a **file browser for on-chain state** — each module is a folder, each key is a file, and you can "watch" any entry.

---

## UX: Tree Navigation

```
Select chain: [Neutron (neutron-1)    ▼]  RPC: [https://rpc-kralum... ]

neutron-1 @ height 52,410,000
├── 📁 bank/
│   ├── 📁 balances/
│   │   ├── 📄 neutron1abc... → 1,000,000 untrn
│   │   ├── 📄 neutron1def... → 500,000 untrn
│   │   └── ... (load more)
│   └── 📁 supply/
│       └── 📄 untrn → 500,000,000,000
├── 📁 wasm/
│   ├── 🔍 [enter contract address]
│   │   ├── 📄 config → {"admin":"neutron1..."}
│   │   ├── 📁 attestations/
│   │   │   ├── 📄 cosmos1abc → {"status":"approved","attester":"neutron1pc3...","height":52407300}  [👁 Watch]
│   │   │   └── 📄 cosmos1def → {"status":"pending",...}  [👁 Watch]
│   │   └── 📄 next_id → 42
│   └── ...
├── 📁 staking/
│   ├── 📁 validators/
│   └── 📁 delegations/
├── 📁 gov/
│   └── 📁 proposals/
└── 📁 ibc/
    └── 📁 connections/
```

### Key features

- **Chain selector**: dropdown with known chains + custom RPC input
- **Module list**: auto-discovered from the multistore (SimpleTree level)
- **Key browsing**: iterate keys under a prefix via `abci_query` with subspace queries
- **Value decoding**: auto-detect protobuf/JSON/raw bytes, pretty-print
- **Contract state**: special UX for wasm module — enter a contract address, browse its cw-storage-plus namespaces
- **Height selector**: browse state at any historical height

---

## "Watch This" — One-Click Subscription Creation

When a user finds a key they want to monitor, they click **[👁 Watch]** and get a dialog:

```
┌─────────────────────────────────────────────────┐
│  Create Interchain Event Subscription            │
│                                                   │
│  Chain:      Neutron (neutron-1)                  │
│  Client ID:  07-tendermint-42 (auto-detected)     │
│  Key path:   wasm / 03_6ddcac...395d_000c...     │
│  Current value: {"status":"approved",...}          │
│                                                   │
│  Condition:                                       │
│  ○ Exists (trigger when key exists)               │
│  ● Equals (trigger when value matches)            │
│  ○ Changes (trigger on any change) [Phase 2]      │
│                                                   │
│  Expected value: [auto-filled from current] 📝    │
│                                                   │
│  Action:                                          │
│  ○ Send tokens                                    │
│  ○ Execute contract                               │
│  ○ Custom (subscriber contract) [Phase 2]         │
│                                                   │
│  [Create Subscription on Cosmos Hub]  🔗 Keplr    │
└─────────────────────────────────────────────────┘
```

The frontend:
1. Auto-detects the IBC `client_id` for the selected chain on the Hub
2. Pre-computes the full IAVL key path from the browsed location
3. Encodes the action as protobuf
4. Builds the `Subscribe` transaction
5. Sends to Keplr for signing

---

## Technical Implementation

### State browsing via RPC

**List modules (SimpleTree level):**
Not directly queryable — maintain a known list of standard Cosmos SDK modules:
`bank`, `staking`, `gov`, `wasm`, `ibc`, `distribution`, `slashing`, `mint`, `auth`, `params`

**List keys under a prefix:**
```
GET /abci_query?path="store/{module}/subspace"&data=0x{prefix_hex}
```
Returns key-value pairs matching the prefix. Paginate by using the last key as the next prefix.

**Read a specific key:**
```
GET /abci_query?path="store/{module}/key"&data=0x{key_hex}
```

**Read with proof (for subscription creation):**
```
GET /abci_query?path="store/{module}/key"&data=0x{key_hex}&prove=true&height={H}
```

### CosmWasm contract state decoding

For the `wasm` module, the key structure is:
```
\x03 + <contract_addr_bytes> + <storage_key>
```

cw-storage-plus namespaces can be discovered by:
1. Querying the contract's raw state with a prefix scan
2. Parsing the 2-byte length prefix to extract namespace names
3. Grouping keys by namespace → display as folders

### IBC client auto-detection

To map a chain_id to a client_id on the Hub:
```
GET /ibc/core/client/v1/client_states
```
Filter by `client_state.chain_id == "neutron-1"` → get `client_id`.

Cache this mapping in the frontend.

### Value decoding

Try in order:
1. JSON parse (CosmWasm state is often JSON)
2. Protobuf decode with known schemas (bank balances, staking delegations, etc.)
3. UTF-8 string
4. Hex dump (fallback)

For CosmWasm contracts, if the contract has published a schema, use it for decoding.

---

## Tech Stack

- **Frontend**: Nuxt 3 (Vue.js) with composables for state management
- **Wallet**: Keplr
- **RPC client**: @cosmjs/tendermint-rpc for abci_query
- **Protobuf**: cosmjs-types + protobufjs for encoding/decoding
- **Tx building**: @cosmjs/stargate + @cosmjs/proto-signing for building Subscribe transactions
- **UI components**: Nuxt UI or PrimeVue for the tree view

---

## Future Enhancements

- **Saved views**: bookmark frequently watched paths
- **Diff view**: compare state at two different heights
- **Live updates**: WebSocket subscription to new blocks, auto-refresh browsed state
- **Proof inspector**: visualize the Merkle proof tree (IAVL + SimpleTree levels)
- **Multi-chain dashboard**: side-by-side state comparison across chains
- **Subscription manager**: view/cancel active subscriptions, see trigger history
- **Watcher status**: see which watchers are active for which chains, uptime stats
