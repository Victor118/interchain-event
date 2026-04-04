# Interchain Events — A Cross-Chain Event Subscription Service for the Cosmos Hub

## Subscribe to state changes on any IBC chain. React automatically.

---

## Executive Summary

Cosmos Labs is building the leading infrastructure for enterprise blockchain: the Network Manager deploys chains, PoA secures them, Cosmos EVM provides Solidity familiarity, and IBC connects them to the Hub. Institutions are onboarding — Progmat, Ondo, SWIFT, SMBC, and more.

But once these chains are live and connected, a critical question arises: **how do they coordinate operations with each other?**

Today, every pair of enterprise chains that wants to coordinate (settlement, compliance, treasury management) must design, develop, and maintain a custom bilateral IBC protocol. This is an N×N integration problem that doesn't scale.

We propose **Interchain Events** — an event subscription service native to the Cosmos Hub that transforms this N×N problem into N×1. Chains subscribe to state changes on other chains and define automatic reactions. Enterprise chains connect to the Hub once, and become instantly composable with every other connected chain. No bilateral negotiations, no custom protocol development, no integration overhead.

Interchain Events generates recurring revenue in ATOM, aligns with the enterprise pivot, and fills the last gap in the Cosmos Enterprise stack.

---

## The Problem: Coordination Between Enterprise Chains

### What enterprises can do today

Cosmos Labs provides everything an institution needs to launch and operate a chain:

- **Deploy** a chain in hours (Network Manager)
- **Secure** it without a token (PoA)
- **Build** with familiar tools (Cosmos EVM, Solidity)
- **Connect** it to the interchain (IBC)
- **Transfer** tokens cross-chain (ICS-20, IFT)

### What enterprises cannot do today

Coordinate **cross-chain state verification and conditional execution** without custom development on both sides.

Consider a compliance workflow: an investor completes KYC on a dedicated identity chain, and should be automatically whitelisted to purchase tokenized securities on Ondo Chain. The desired logic is simple: "when KYC status = APPROVED on the identity chain, whitelist the investor on Ondo."

Today, this requires bilateral integration:

1. Design a shared IBC packet format for KYC notifications
2. Develop and deploy matching smart contracts on both the identity chain and Ondo
3. Open a dedicated IBC channel between them
4. Maintain a relayer for this channel
5. Test, audit, and maintain both sides continuously
6. Repeat the entire process for every new identity provider Ondo wants to support

This is the same N×N integration problem that SWIFT solved for banks in the 1970s. Every new partnership requires months of bilateral integration work. It doesn't scale with the number of enterprise chains Cosmos Labs is onboarding.

Note: for simple token transfers between chains, ICS-20 (and soon IFT) already provide a standardized solution. The Interchain Events addresses a different category of needs — **verifying states and coordinating actions that don't involve moving tokens**. A KYC status cannot be "transferred" via ICS-20. A settlement finality status cannot be "bridged." These are cross-chain state dependencies that require verification, not transfer.

### Why IBC alone doesn't solve this

IBC provides the transport — secure, trustless packet delivery between chains. But IBC doesn't provide the coordination logic. It's TCP/IP, not HTTP. You still need an application protocol on top, and today each pair of chains must build their own.

The result: enterprise chains can send tokens to each other via ICS-20, but they cannot easily coordinate conditional business logic based on each other's states.

---

## The Solution: Interchain Events

### What it is

Interchain Events is a cross-chain state verification primitive on the Cosmos Hub. It verifies cryptographic proofs of remote chain state and calls subscriber smart contracts with the verified data. What those contracts do with the data is entirely up to them.

It works in three steps:

1. **Subscribe** — A smart contract registers a subscription: "watch this key on this chain, and call me back with the verified value when someone submits a proof"
2. **Detect** — A watcher monitors the source chain off-chain, or the interested party submits the proof themselves
3. **Verify & Callback** — The Hub verifies the proof against its IBC light client and calls the subscriber contract with the verified data. The subscriber contract decides what to do: execute an ICA, release an escrow, create the next subscription, or anything else

### Why it must live on the Hub

The Cosmos Hub maintains IBC light clients for the largest number of chains in the ecosystem. It is the only point where states from N different chains can be verified and coordinated in a single atomic operation.

No individual enterprise chain has this breadth of connectivity. Only the Hub can serve as the universal coordination point.

### N×1 instead of N×N

Each enterprise chain connects to the Hub once via IBC. From that moment, it can participate in coordinated workflows with every other connected chain, without any bilateral integration.

Progmat connects to the Hub → it can coordinate with Ondo, Noble, CBDC chains, and any future enterprise chain, all through the same Interchain Events. Adding a new counterparty is a configuration change, not a development project.

### Subscription lifecycle

A subscription is triggered once and consumed. Once the event is detected and the action executed, the subscription is closed. This keeps the protocol simple and predictable.

For ongoing workflows (e.g., processing every new settlement as it arrives), the **subscriber contract** decides whether to re-subscribe in its callback. For example, a payment contract that processes settlements at index N can create a new subscription for index N+1 in the same callback. This turns a simple one-shot primitive into a continuous processing pipeline — but the looping logic lives in the business contract, not in the protocol.

This design is intentional: the protocol provides a single, auditable verification primitive. The subscriber decides if, when, and how to continue. Different business contracts can implement different strategies — retry on failure, stop after N events, switch conditions dynamically — without any protocol changes.

### Who triggers the events?

Event detection requires someone to submit a cryptographic proof to the Hub. Three models coexist:

**Self-service** — The party who benefits from the event submits the proof themselves. An investor who just completed KYC submits the proof to trigger their whitelisting. This is the most common case: the beneficiary is naturally motivated to trigger the reaction.

**Counterparty-driven** — The other party in the transaction submits the proof to advance the workflow. In a DVP, the buyer submits the proof of payment to trigger the asset transfer.

**Watcher network** — For cases where no party is immediately available, independent watchers monitor chains and submit proofs in exchange for a fee. The subscription creator deposits a bounty that watchers earn for each proof submitted. If the beneficiary submits faster than the watchers, they save the bounty. Watchers serve as a reliability backstop, not the primary mechanism.

This design ensures liveness without creating dependency on any single actor. The system works even if watchers disappear — the interested parties can always submit proofs themselves.

### Security model: oracle-grade assurance without oracle trust

Cross-chain data verification is traditionally handled by oracle networks (Chainlink, Pyth). These systems aggregate reports from multiple independent witnesses and derive a consensus — the security depends on the honesty of a majority of oracle operators.

The Interchain Events operates differently. Watchers are **transporters**, not **witnesses**. A watcher reads on-chain state, generates a Merkle proof, and submits it to the Hub. The IBC light client on the Hub verifies the proof mathematically against the consensus state of the remote chain. A watcher cannot forge, alter, or misrepresent the data — an invalid proof is rejected by the cryptographic verification. The worst a malicious watcher can do is not submit a proof at all, which is mitigated by watcher competition and self-service submission.

This means the Interchain Events delivers **the convenience of an oracle with the security of a light client**. No trusted committee, no aggregation threshold, no economic staking assumption. Just mathematics. For enterprise clients operating in regulated environments, this distinction matters: the audit trail shows a cryptographic proof verified against a blockchain's consensus, not a majority vote among third-party service providers.

---

## Use Cases

In all use cases below, Interchain Events only verifies the proof and calls back the subscriber contract. The subscriber contract implements the business logic and executes the resulting action (ICA, escrow release, token transfer, etc.).

### 1. Cross-Chain Compliance Gate

**Actors:** KYC/Identity chain, Ondo (tokenized securities)

**Subscription:** "Watch `kyc/<address>` on identity chain, call my compliance contract when proof is submitted"

**Subscriber reacts:** The compliance contract receives the verified KYC status and whitelists the investor on Ondo via ICA.

**Value:** Compliance verification is decoupled from the asset chain. Ondo doesn't need to integrate every KYC provider bilaterally. The Hub verifies the status, the subscriber contract authorizes access. Adding a new identity provider is a configuration change on the Hub, not a development project on Ondo.

### 2. Cross-Chain Escrow with Third-Party Certification

**Actors:** Payment chain (Noble), Service provider chain, Audit chain

**Subscription:** "Watch `certifications/<contract_id>` on audit chain, call my escrow contract when proof is submitted"

**Subscriber reacts:** The escrow contract receives the verified certification status and releases payment on Noble.

**Value:** Three parties, three chains, zero bilateral integration. The payer, the provider, and the auditor each operate on their own chain. The subscriber contract on the Hub coordinates the conditional payment based on the auditor's independent certification.

### 3. Multi-Jurisdictional CBDC Settlement

**Actors:** CBDC chain A (Bank of Japan pilot), CBDC chain B (another central bank)

**Subscription:** "Watch `settlements/<id>/status` on CBDC chain A, call my settlement contract when proof is submitted"

**Subscriber reacts:** The settlement contract receives the verified finality status and executes settlement leg B on CBDC chain B via ICA.

**Value:** Atomic conditional settlement between sovereign monetary systems. Neither central bank integrates the other's infrastructure directly. CBDC tokens are sovereign instruments that will not be wrapped or bridged — cross-chain state verification is the only viable coordination mechanism.

### 4. Continuous Settlement Flow

**Actors:** Progmat (tokenized bonds), Noble (USDC payments)

**Subscription:** "Watch `settlements/42` on Progmat, call my payment contract when proof is submitted"

**Subscriber reacts:** The payment contract executes the corresponding payment on Noble, then creates a new subscription for `settlements/43` in the same callback. The chain continues as long as the business contract re-subscribes.

**Value:** An automated pipeline between two institutions built entirely from one-shot subscriptions. Dozens of settlements per day, each verified and executed automatically. The operational equivalent of a standing SWIFT instruction, but trustlessly verified and cross-chain. The looping logic is in the subscriber contract, not in the protocol — the institution controls when to continue or stop.

### 5. Delivery vs. Payment (DVP) for Regulated Assets

**Actors:** Progmat (tokenized bonds), Noble (USDC payments)

**Subscription:** "Watch `ownership/<bond_id>` on Progmat, call my DVP contract when proof is submitted"

**Subscriber reacts:** The DVP contract verifies the new owner matches the buyer, then releases USDC from escrow on Noble to the seller via ICA.

**Context:** This use case applies specifically when assets are regulated to remain on their chain of issuance — the bond must stay on Progmat's regulated registry, and the USDC must remain on Noble as recognized by Circle. In scenarios where both parties accept wrapped tokens on a single chain, a simpler atomic swap via ICS-20 is sufficient.

**Value:** For regulated assets that cannot leave their issuance chain, Interchain Events enables settlement without wrapping or bridging — two sovereign registries, coordinated without either compromising their regulatory status.

### 6. Multi-Hop Compliance via Proof Routing

**Actors:** Identity chain (no direct IBC to Ondo), Cosmos Hub (intermediary), Ondo (tokenized securities)

**Step 1 subscription (Hub):** "Watch `kyc/<investor>` on identity chain, call my relay contract when proof is submitted"

**Step 1 subscriber reacts:** The relay contract on the Hub verifies the KYC proof and writes `kyc_verified/<investor> → approved` into its own state.

**Step 2 subscription (Ondo):** "Watch `kyc_verified/<investor>` on the Hub, call my compliance contract when proof is submitted"

**Step 2 subscriber reacts:** The compliance contract on Ondo reads the verified status and whitelists the investor.

**Value:** Ondo verifies KYC from an identity chain it has never integrated with. The Hub serves as a trust relay — each hop is cryptographically verified. Adding a new identity provider requires zero changes on Ondo.

### 7. Automated Treasury Management

**Actors:** Noble (USDC), Ondo (OUSG yield-bearing)

**Subscription:** "Watch `balances/<treasury_address>` on Noble, call my treasury contract when proof is submitted"

**Subscriber reacts:** The treasury contract checks if the verified balance exceeds the threshold, and if so deploys excess to OUSG on Ondo via ICA. If below threshold, it recreates the same subscription to keep watching.

**Value:** Automated cross-chain treasury operations. The treasury contract defines rules once. No manual intervention.

---

## How It Fits the Cosmos Enterprise Stack

The Interchain Events doesn't require new infrastructure. It consumes every component Cosmos Labs has already built:

| Existing Component | Role in Interchain Events |
|---|---|
| **IBC Light Clients (07-tendermint)** | Verify states on connected Cosmos chains trustlessly |
| **ICA (Interchain Accounts)** | Available to subscriber contracts for executing actions on destination chains |
| **CosmWasm on Hub** | Host the Interchain Events smart contracts |
| **Network Manager** | Deploy and connect enterprise chains to the Hub |
| **PoA** | Secure enterprise chains without tokens |
| **Cosmos EVM** | Enterprise chains write Solidity, their state is verifiable via IAVL |

The Interchain Events is the application layer that ties all of these infrastructure components into a single, revenue-generating product.

---

## Verification Mechanisms

The Interchain Events supports multiple verification mechanisms depending on the chain's level of integration:

### VerifyMembership (passive state verification)

The Hub reads the state of a remote chain via its IBC light client, without any cooperation from the remote chain. A user or watcher submits a Merkle proof, the Hub verifies it cryptographically against the light client's stored consensus state. This is fully trustless and requires nothing from the remote chain.

**Best for:** Verifying irrevocable states like settlement finality, KYC status, governance results, asset ownership.

### Direct IBC Notification (cooperative chains)

For chains that actively participate, a lightweight proxy contract on the source chain executes the local action and sends an IBC notification to the Hub. This is the richest and fastest mechanism — the notification contains full details of what happened (who, what, how much).

**Best for:** Chains deployed by Cosmos Labs via Network Manager, chains that choose deeper integration for richer coordination capabilities.

Both mechanisms feed into the same Interchain Events interface. The enterprise client defines subscriptions in business terms, and the Hub resolves the verification path automatically.

### Multi-Hop Proof Routing (Transitive State Verification)

Not every chain pair has a direct IBC light client connection. Chain A may need to verify state on Chain C, but only has a light client for Chain B — which itself has a light client for Chain C. Interchain Events enables **transitive verification** through subscription chaining:

1. **Chain B** runs an Interchain Events contract that subscribes to Chain C's state. When a proof is submitted and verified, the callback contract on Chain B writes the verified result into its own on-chain state (e.g., `verified_events/chain_c/attestation_42 → true`).

2. **Chain A** runs an Interchain Events contract that subscribes to Chain B's state — specifically, the verification result written by step 1. When that state is proven, Chain A knows that Chain C's original event occurred, without ever having a direct light client connection to Chain C.

The trust model is explicit and composable: Chain A trusts Chain B's validators (via its A→B light client), and Chain B trusts Chain C's validators (via its B→C light client). This is the same transitive trust that underpins multi-hop routing in traditional networks, but with cryptographic verification at each hop.

This pattern has several powerful properties:

- **Reach beyond direct connections** — Any chain can verify state on any other chain reachable through a path of light clients, without requiring the entire ecosystem to maintain N×N connections.
- **Composable verification pipelines** — The callback on Chain B could itself be an Interchain Events contract that automatically creates subscriptions to other chains, forming multi-step verification workflows that span three or more chains.
- **Hub as routing backbone** — The Cosmos Hub, with its extensive light client connections, naturally serves as an intermediary for chains that lack direct connections to each other.
- **No protocol changes required** — Multi-hop routing emerges naturally from the existing subscription + callback mechanism. No new message types, no new verification logic — just subscriptions observing other subscriptions' results.

**Example: Three-chain compliance flow**

An identity chain (Chain C) issues KYC approvals. A tokenized securities chain (Chain A) needs to verify KYC status but has no direct light client for the identity chain. The Hub (Chain B) bridges the gap:

1. Hub subscribes to `kyc/<investor>` on Chain C → callback writes `kyc_verified/<investor> → approved` on Hub
2. Securities chain subscribes to `kyc_verified/<investor>` on Hub → callback whitelists the investor

The securities chain never integrates with the identity chain. The Hub absorbs the verification complexity and serves as the trust relay.

### Embedded Light Client (Protocol Autonomy)

In production, Interchain Events can embed a Tendermint light client directly in the smart contract, rather than depending on the host chain's IBC module to query ConsensusState. The contract maintains its own store of verified consensus states (app_hash + validator set), updated by watchers who submit signed block headers.

This design makes the protocol **fully autonomous**:

- **Deployable on any CosmWasm chain** — no dependency on chain-specific features like gRPC query whitelists or IBC module access from smart contracts.
- **Watchers are the relayers** — the same actors who submit proofs also maintain the light client, but only for the specific heights they need (not every block). They are incentivized by subscription bounties.
- **Same security guarantees** — the contract verifies validator signatures and 2/3+ voting power before accepting a header, identical to the IBC light client security model.

This is the same approach used by protocols like Polymer and Union for cross-chain verification at the contract level.

### Interchain State Explorer

Subscribing to events requires knowing the exact state path to monitor — which module, which key prefix, which data format. This is opaque for non-technical users.

The Interchain State Explorer is a companion tool that makes remote chain state browsable and discoverable. It connects to any IBC-connected chain's RPC and displays its state as a navigable tree — the equivalent of a database client that shows tables, columns, and rows. Users can browse native Cosmos SDK modules (bank balances, staking delegations, governance proposals) and CosmWasm contract state (decoded key-value pairs with human-readable names).

The key feature: **click any state path to create a subscription directly**. The explorer pre-fills the chain, path, data format, and verification mechanism. The user only needs to define the trigger condition and the action. This transforms subscription creation from a technical exercise into a point-and-click operation.

For Cosmos Labs, the State Explorer is also a discovery tool — enterprise clients can explore the state of partner chains before deciding which events to subscribe to, accelerating the onboarding process.

---

## Revenue Model

### For the Cosmos Hub and ATOM holders

Every interaction with Interchain Events generates economic activity on the Hub:

- **Subscription registration** — Gas fees in ATOM for creating event subscriptions
- **Proof verification** — Gas fees in ATOM for each event detection (VerifyMembership, IBC packet processing)
- **Action execution** — Gas fees in ATOM for subscriber contract callbacks and their resulting actions (ICA, escrow release, token transfers, etc.)
- **Re-subscription chains** — Subscriber contracts that re-subscribe in their callback create continuous workflows. Each step generates gas fees for verification and execution. A single workflow between two institutions can generate dozens of transactions per day.
- **Watcher bounties** — Optional deposits in ATOM to incentivize third-party watchers. If the beneficiary submits proofs themselves, bounties are not consumed.

This is non-inflationary, usage-based revenue. Subscriber contracts that re-subscribe create **recurring** ATOM demand — not one-time fees but ongoing gas consumption proportional to the volume of cross-chain business activity. The more enterprise chains Cosmos Labs onboards, the more subscriptions are created, the more ATOM is consumed.

### For Cosmos Labs

Interchain Events extends the value of every enterprise deployment:

- **Upsell to existing Network Manager clients** — "Your chain is live. Now subscribe to events across the interchain."
- **Increased stickiness** — Enterprise chains that depend on Interchain Events for cross-chain workflows are deeply embedded in the Cosmos ecosystem
- **Network effects** — Each new enterprise chain makes Interchain Events more valuable for all existing chains. The N×1 model means value grows quadratically with the number of connected chains
- **Professional services revenue** — Custom subscription templates, integration support, SLA management

### For enterprise clients

The ROI is clear:

- **Months of bilateral integration → days of configuration**
- **Custom protocol development → standardized subscription templates**
- **Per-partnership maintenance → single Hub connection**
- **Manual confirmation processes → automated, verifiable execution**

---

## Competitive Landscape

| Solution | Approach | Limitation |
|---|---|---|
| **Custom IBC protocols** | Bilateral IBC apps | N×N integration, months per partnership |
| **Atom-intents (iqlusioninc)** | Solver network + escrow | Focused on DeFi trading, not enterprise state coordination |
| **Intento** | L1 chain, cron + ICQ polling | Separate chain with own token, validator-trust model, polling cost even when idle |
| **Axelar GMP** | General message passing | No conditional logic or state verification |
| **LayerZero / Wormhole** | Bridge + multisig | Bridge-centric, multisig trust model, no native Cosmos integration |
| **Agoric Orchestration** | Smart contract orchestration | On Agoric, not the Hub |

### Intento comparison

Intento is the closest existing product to Interchain Events. It is a dedicated Cosmos L1 that orchestrates cross-chain flows using ICA and ICQ. Flows are configured with intervals (hourly, daily) and conditions checked via Interchain Queries at each interval.

Key differences with Interchain Events:

**Cost model**: Intento's validators execute ICQ at every interval regardless of whether the condition is met — polling burns resources even when idle. Interchain Events has zero on-chain cost until the event actually occurs. The submitter only pays gas when the proof is submitted.

**Trust model**: Intento relies on its own validator set to correctly execute ICQ and report results — a validator-trust model. Interchain Events verifies ICS-23 Merkle proofs against IBC light clients — a mathematical-trust model. The proof is either valid or invalid, no trust in any third party required.

**Infrastructure**: Intento requires a separate L1 with its own token ($INTO), validator set, and security budget. Interchain Events is a CosmWasm contract on the Cosmos Hub — no new chain, no new token, leveraging the Hub's existing security and light client infrastructure.

**Latency**: Intento's detection depends on the configured interval — if set to 1 hour, a condition met at minute 1 waits 59 minutes. Interchain Events reacts as soon as the proof is submitted, typically within seconds of the event.

**UX**: Intento has a mature portal with visual flow builder and templates — a significant advantage today. Interchain Events would need to build equivalent tooling, including the proposed Interchain State Explorer.

Interchain Events is not a replacement for Intento's full automation capabilities (recurring cron flows, feedback loops). It targets a different segment: enterprise cross-chain coordination where trustless verification, minimal infrastructure overhead, and integration with the Hub's service ecosystem matter more than general-purpose flow automation.

---

## Implementation Path

### Phase 1: Core Product (8-12 weeks)

- CosmWasm contract on the Hub: subscription registration, multi-source event matching, execution triggers
- Integration with IBC light clients for VerifyMembership
- Integration with ICA for action execution
- Basic subscription templates (state equality, threshold comparison)

### Phase 1b: Embedded Light Client (4-6 weeks)

- Tendermint light client in CosmWasm: header verification, validator set tracking, consensus state storage
- Watcher-submitted headers with validator signature verification (ed25519, 2/3+ voting power)
- Skip verification for non-consecutive headers (within trusting period)
- Removes dependency on host chain's IBC module for ConsensusState queries
- Makes the protocol deployable on any CosmWasm chain without special permissions

### Phase 2: Proxy Contracts and IBC Notifications (6-8 weeks)

- CosmWasm proxy contract for cooperative Cosmos chains
- Solidity proxy contract for Cosmos EVM chains (via ICS-20 memo pattern or IBC v2)
- Rich notification format with full transaction attribution
- Dashboard for subscription monitoring

### Phase 3: Interchain State Explorer (6-8 weeks)

- Web-based explorer that connects to any IBC-connected chain's RPC and displays its state as a navigable tree: modules, keys, values
- Browse native modules (bank, staking, governance) and CosmWasm contract state with decoded key-value pairs
- Click-to-subscribe: select any state path in the explorer and create an Interchain Events subscription directly — the path, chain, and data format are pre-filled automatically
- Proof preview: generate and inspect VerifyMembership proofs for any key before committing to a subscription

### Phase 4: Enterprise Features (ongoing)

- Subscription templates marketplace (DVP, compliance, treasury management)
- Premium enterprise access (guaranteed SLAs, priority execution)
- SLA-backed watcher network
- Enterprise dashboard and API

---

## The Ask

We propose that Cosmos Labs evaluate the Interchain Events as a native service of the Cosmos Hub, integrated into the Enterprise offering:

1. **Validate the demand** — Do current enterprise clients (Progmat, Ondo, SWIFT pilots) express a need for cross-chain coordination beyond simple token transfers?

2. **Assess strategic fit** — Does the Interchain Events align with Cosmos Labs' vision for the Hub as the coordination center of the interchain?

3. **Explore collaboration** — We have a detailed technical specification ready and can contribute to development. We are looking for guidance on enterprise client needs and integration priorities.

The infrastructure is built. The enterprise clients are arriving. The coordination layer is the missing piece that turns a collection of connected chains into a composable financial network.

---

*Contact: [your info]*

*Technical specification available upon request.*

---

## Annex A: Dual-Proof Change Detection

### The problem

VerifyMembership proves that a value exists at a specific block height. It does not prove that the value has **changed**. For conditions based on state transitions (e.g., "when balance exceeds a threshold", "when status changes from pending to finalized"), a single proof is ambiguous — the contract cannot distinguish a fresh change from a state that has been true for days.

### The solution: dual-proof at consecutive heights

The submitter provides two Merkle proofs for the same key at two consecutive block heights:

- **Proof at block H-1**: value = V1 (condition NOT met)
- **Proof at block H**: value = V2 (condition met)

The contract verifies both proofs against their respective ConsensusStates in the IBC light client and confirms that the transition occurred between H-1 and H.

### Transaction structure

The submitter (watcher or self-service user) constructs a single atomic transaction containing:

1. `MsgUpdateClient` — update light client to height H-1 (if not already present)
2. `MsgUpdateClient` — update light client to height H
3. `ExecuteMsg::SubmitDualProof` — both proofs + subscription ID

The submitter acts as its own relayer — no dependency on external relayers for the specific heights needed.

### Subscription types by proof mode

| Subscription type | Proof mode | Example |
|---|---|---|
| Absolute state | Single proof | KYC = approved, settlement = finalized |
| Incremental index (re-subscribe in callback) | Single proof | New item at index N+1 |
| Threshold crossing | Dual proof (H-1 and H) | Balance crosses 5M USDC |
| State transition | Dual proof (H-1 and H) | Status changes from pending to active |

### Security properties

- **No replay**: the contract records the last processed height pair per subscription. Resubmitting the same proofs is rejected.
- **No false positives**: both proofs are verified cryptographically. The submitter cannot forge a transition that didn't occur.
- **Consecutive height enforcement**: the contract can enforce H - (H-1) = 1 for strict consecutivity, or accept a configurable maximum gap for practical flexibility.
- **Natural expiry**: ConsensusStates are pruned after the light client's trusting period (~2 weeks). Old proofs become unverifiable automatically.

### Gas estimation

- 2× MsgUpdateClient: ~200-300k gas (validator signature verification dominates)
- 2× VerifyMembership via Stargate query: ~20-40k gas (IAVL Merkle proof verification, ~25 SHA256 hashes per proof)
- Contract logic: ~20-30k gas
- **Estimated total: ~350-500k gas** — within normal transaction limits, comparable to a standard ICS-20 transfer with memo

This estimate requires validation through testnet benchmarking as part of the Phase 1 implementation.