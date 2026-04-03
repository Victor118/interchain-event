# Tokenomics Annex — Interchain Events as Hub Revenue Source

## Context

This document connects the Interchain Events product to the [Revenue-Linked Inflation](https://forum.cosmos.network/t/tokenomic-revenue-linked-inflation/16618) tokenomics proposal for the Cosmos Hub.

The core idea of Revenue-Linked Inflation is:
- **Inflation = Target Security Budget − Actual Revenues**
- As on-chain revenues grow, inflation decreases automatically
- A Revenue Stream Module allows ecosystem partners to contribute funds that count as revenue
- These revenues flow into the fee collector, rewarding validators and stakers

Interchain Events would become a **native revenue source** for the Hub, directly feeding the fee collector and reducing inflation.

---

## The Problem

Currently, a CosmWasm smart contract **cannot send funds to the fee collector**. The fee collector is a module account managed by the Cosmos SDK's `auth` module. Only the SDK's internal fee handling (tx fees, tips) feeds into it. There's no `MsgSendToFeeCollector` or equivalent.

This means any revenue model built purely in CosmWasm is limited to:
- Sending to the community pool (`MsgFundCommunityPool`) — not the same, doesn't reward stakers directly
- Sending to a treasury address controlled by governance — requires manual distribution
- Burning tokens — deflationary but doesn't reward stakers

None of these replicate the direct "revenue → fee collector → stakers/validators" loop.

---

## The Solution: Revenue Stream Module

The Revenue Stream Module proposed in the tokenomics forum post solves this:

1. **Permissionless revenue streams**: Anyone (including smart contracts) can create a revenue stream that feeds into the fee collector
2. **Progressive distribution**: Revenue streams distribute funds over time (per-block), not lump-sum
3. **Whitelisted denoms**: Governance controls which tokens count as revenue (ATOM, USDC, etc.)
4. **Counted in inflation formula**: Revenue from streams reduces inflation proportionally

### How Interchain Events would use it

The contract **accumulates** subscription fees internally. When the accumulated balance reaches a governance-defined threshold, anyone can trigger a `FlushRevenue` that creates a single consolidated Revenue Stream.

```
Subscribe #1 → 0.5 ATOM fee → contract balance: 0.5 ATOM
Subscribe #2 → 0.3 ATOM fee → contract balance: 0.8 ATOM
SubmitProof #1 → watcher bounty 0.05 ATOM → contract balance: 0.75 ATOM
Subscribe #3 → 0.4 ATOM fee → contract balance: 1.15 ATOM
  → threshold reached (1 ATOM)!

FlushRevenue {} (permissionless, anyone can call)
  → MsgCreateRevenueStream(1.15 ATOM, duration: 7 days)
  → contract balance reset to 0
  → 1.15 ATOM streams into fee collector over 7 days
  → validators and stakers earn from subscriptions
```

This batching approach:
- Reduces on-chain overhead (one stream per batch, not per subscription)
- Allows permissionless flushing (keeper-style, could even reward the flusher)
- Smooths revenue over time via the stream duration parameter

```rust
ExecuteMsg::FlushRevenue {}
  → if balance >= threshold → create revenue stream
  → if balance < threshold → error "threshold not reached"
```

### Revenue split

```
Subscription fee: 1 ATOM
  ├── 10% → Watcher bounty (paid on SubmitProof)
  └── 90% → Accumulated → Revenue Stream → fee collector → validators/stakers
```

---

## Incentive Alignment

This creates a virtuous cycle:

```
More subscriptions
  → more revenue streams
  → more staking rewards
  → higher ATOM price / lower inflation
  → more attractive to stake
  → more security for the Hub
  → more trust in proof verification
  → more subscriptions
```

### For validators/stakers
- Interchain Events directly increases their rewards
- Incentivized to support the product in governance
- The more the interchain uses the Hub as a proof oracle, the more staking pays

### For watchers
- Bounty per proof submitted — permissionless income
- Specialization by chain (Neutron watcher, Osmosis watcher, etc.)
- Competition drives reliability and speed

### For subscribers
- Pay for a verifiable, trustless cross-chain oracle
- Cost is predictable (subscription fee upfront)
- No intermediary — proof is cryptographic, not attestation-based

### For the Hub
- New revenue source that scales with interchain activity
- Positions the Hub as essential infrastructure (not just staking chain)
- Revenue reduces inflation → healthier tokenomics

---

## Why This Requires a Native Module

A pure CosmWasm implementation can approximate this with:
- Deposit-based subscriptions (funds held by contract)
- Watcher bounties (contract sends to watcher)
- Community pool funding (`MsgFundCommunityPool`)

But it **cannot** achieve the core value proposition:
- ❌ Direct revenue to fee collector
- ❌ Per-block streaming (only lump-sum transfers)
- ❌ Counted in inflation formula
- ❌ Validator/staker rewards from subscriptions

The Revenue Stream Module bridges this gap. With it, the Interchain Events contract would call `MsgCreateRevenueStream` to channel subscription fees into the fee collector, completing the loop.

---

## Implementation Path

### Phase 1 (current — CosmWasm POC)
- Proof of concept — validates ICS-23 proof verification
- No fee model yet
- Free subscriptions for testing

### Phase 2 (CosmWasm + fee accumulation)
- Subscription fees collected by the contract
- Watcher bounties paid from accumulated fees on SubmitProof
- Remaining funds either:
  - **Retained in contract** — admin/multisig can withdraw to fund development and maintenance
  - **Sent to community pool** via `MsgFundCommunityPool` — more transparent, governance allocates
- Both approaches coexist: a split (e.g., 50% retained for dev, 50% community pool)

### Phase 3 (Revenue Stream Module)
- Governance proposal for Revenue Stream Module
- Migrate contract: replace community pool flush with `MsgCreateRevenueStream`
- Subscription revenue counted in inflation formula
- Full tokenomics loop: subscriptions → fee collector → stakers/validators → reduced inflation

### Phase 4 (Scale)
- Multiple chains watchable (Neutron, Osmosis, Stride, Noble, etc.)
- Watcher marketplace with reputation
- State Explorer frontend for one-click subscriptions
- Revenue scales with interchain adoption
- Dev fund transitions from retained fees to governance-funded grants as the protocol matures

---

## Governance Proposal Narrative

> "The Cosmos Hub should be the trust anchor of the interchain. Interchain Events turns the Hub's IBC light clients into a revenue-generating oracle service. Every chain that connects to the Hub via IBC becomes a potential source of verifiable state that other chains can subscribe to.
>
> With the Revenue Stream Module, subscription fees flow directly to validators and stakers, reducing the need for inflation. The more the interchain grows, the more the Hub earns. This transforms the Hub from a passive staking chain into active infrastructure that the entire ecosystem pays to use."
