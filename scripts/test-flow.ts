#!/usr/bin/env tsx
/**
 * Interchain Events - Full Test Flow
 *
 * This script automates the full test scenario:
 *   1. Write an attestation on Neutron (attestation-registry)
 *   2. Create a subscription on the Hub (interchain-events)
 *   3. Fetch the Merkle proof from Neutron
 *   4. Submit the proof to the Hub (interchain-events)
 *   5. Query proof-callback to verify the event was recorded
 *
 * Steps 1 & 2 require a signer (mnemonic via MNEMONIC env var).
 * Steps 3-5 can run read-only if a subscription already exists.
 *
 * Usage:
 *   # Full flow (needs both mnemonics):
 *   MNEMONIC_HUB="..." MNEMONIC_NEUTRON="..." npx tsx test-flow.ts
 *
 *   # Just query existing state (read-only):
 *   npx tsx test-flow.ts --query-only
 *
 *   # Submit proof for existing subscription (needs Hub mnemonic):
 *   MNEMONIC_HUB="..." npx tsx test-flow.ts --submit-proof --subscription-id=1 --attestation-id=cosmos1abc
 */

import {
  SigningCosmWasmClient,
  CosmWasmClient,
} from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { toBase64, fromBase64, toUtf8 } from "@cosmjs/encoding";

import {
  HUB_RPC,
  NEUTRON_RPC,
  HUB_CHAIN_ID,
  NEUTRON_CHAIN_ID,
  NEUTRON_REVISION_NUMBER,
  NEUTRON_LIGHT_CLIENT_ID,
  INTERCHAIN_EVENTS_ADDRESS,
  PROOF_CALLBACK_ADDRESS,
  ATTESTATION_REGISTRY_ADDRESS,
} from "./config.js";

import { buildAttestationIavlKey, bytesToHex } from "./iavl-key.js";
import { fetchStateWithProof, encodeProofForContract } from "./proof.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getHubClient(): Promise<CosmWasmClient> {
  return CosmWasmClient.connect(HUB_RPC);
}

async function getNeutronClient(): Promise<CosmWasmClient> {
  return CosmWasmClient.connect(NEUTRON_RPC);
}

async function getHubSigningClient(
  mnemonic: string
): Promise<{ client: SigningCosmWasmClient; address: string }> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "cosmos",
  });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(
    HUB_RPC,
    wallet,
    { gasPrice: GasPrice.fromString("0.005uatom") }
  );
  return { client, address: account.address };
}

async function getNeutronSigningClient(
  mnemonic: string
): Promise<{ client: SigningCosmWasmClient; address: string }> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "neutron",
  });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(
    NEUTRON_RPC,
    wallet,
    { gasPrice: GasPrice.fromString("0.01untrn") }
  );
  return { client, address: account.address };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.substring(2).split("=");
      flags[key] = value ?? true;
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Step 1: Write attestation on Neutron
// ---------------------------------------------------------------------------

async function writeAttestation(
  mnemonic: string,
  attestationId: string,
  status: string
) {
  console.log(`\n=== Step 1: Write attestation on Neutron ===`);
  console.log(`  ID: ${attestationId}`);
  console.log(`  Status: ${status}`);

  const { client, address } = await getNeutronSigningClient(mnemonic);

  const msg = { attest: { id: attestationId, status } };
  const result = await client.execute(
    address,
    ATTESTATION_REGISTRY_ADDRESS,
    msg,
    "auto"
  );

  console.log(`  TX: ${result.transactionHash}`);
  console.log(`  Height: ${result.height}`);

  // Verify
  const queryResult = await client.queryContractSmart(
    ATTESTATION_REGISTRY_ADDRESS,
    { get_attestation: { id: attestationId } }
  );
  console.log(`  Attestation: ${JSON.stringify(queryResult)}`);

  client.disconnect();
  return result.height;
}

// ---------------------------------------------------------------------------
// Step 2: Create subscription on the Hub
// ---------------------------------------------------------------------------

async function createSubscription(
  mnemonic: string,
  clientId: string,
  attestationId: string
): Promise<number> {
  console.log(`\n=== Step 2: Create subscription on the Hub ===`);
  console.log(`  Client ID: ${clientId}`);
  console.log(`  Attestation ID: ${attestationId}`);
  console.log(`  Callback contract: ${PROOF_CALLBACK_ADDRESS}`);

  const { client, address } = await getHubSigningClient(mnemonic);

  const callbackMsg = toBase64(toUtf8(JSON.stringify({ on_proof_verified: {} })));

  const msg = {
    subscribe: {
      client_id: clientId,
      key_path: ["wasm"],
      condition: { json_path_equals: { path: "status", expected: "approved" } },
      callback_contract: PROOF_CALLBACK_ADDRESS,
      callback_msg: callbackMsg,
      expires_after_blocks: null,
    },
  };

  console.log(`  Message: ${JSON.stringify(msg)}`);

  const result = await client.execute(
    address,
    INTERCHAIN_EVENTS_ADDRESS,
    msg,
    "auto"
  );

  console.log(`  TX: ${result.transactionHash}`);

  // Extract subscription_id from events
  const subIdAttr = result.events
    .flatMap((e) => e.attributes)
    .find((a) => a.key === "subscription_id");
  const subscriptionId = subIdAttr ? parseInt(subIdAttr.value, 10) : 1;
  console.log(`  Subscription ID: ${subscriptionId}`);

  client.disconnect();
  return subscriptionId;
}

// ---------------------------------------------------------------------------
// Step 3: Fetch proof and submit to Hub
// ---------------------------------------------------------------------------

async function submitProof(
  mnemonic: string,
  subscriptionId: number,
  attestationId: string,
  proofHeight?: number
) {
  console.log(`\n=== Step 3: Fetch proof from Neutron and submit to Hub ===`);
  console.log(`  Subscription ID: ${subscriptionId}`);
  console.log(`  Attestation ID: ${attestationId}`);

  // Build the IAVL key
  const iavlKey = buildAttestationIavlKey(attestationId);
  console.log(`  IAVL key (hex): ${bytesToHex(iavlKey)}`);

  // Fetch state with proof
  const proof = await fetchStateWithProof(bytesToHex(iavlKey), proofHeight);
  console.log(`  Proof fetched at height: ${proof.height}`);

  // Encode for contract (also fetches app_hash from block header)
  const encoded = await encodeProofForContract(proof);

  // Build SubmitProof message
  const msg = {
    submit_proof: {
      subscription_id: subscriptionId,
      height: {
        revision_number: NEUTRON_REVISION_NUMBER,
        revision_height: proof.height,
      },
      app_hash: encoded.app_hash,
      proof: encoded.proof,
      key: encoded.key,
      value: encoded.value,
    },
  };

  console.log(`\n  SubmitProof message:`);
  console.log(`    subscription_id: ${subscriptionId}`);
  console.log(
    `    height: { revision_number: ${NEUTRON_REVISION_NUMBER}, revision_height: ${proof.height} }`
  );
  console.log(`    app_hash: ${encoded.app_hash.substring(0, 60)}...`);
  console.log(`    proof: ${encoded.proof.substring(0, 60)}...`);
  console.log(`    key: ${encoded.key}`);
  console.log(`    value: ${encoded.value}`);

  const { client, address } = await getHubSigningClient(mnemonic);

  console.log(`\n  Submitting proof...`);
  const result = await client.execute(
    address,
    INTERCHAIN_EVENTS_ADDRESS,
    msg,
    "auto"
  );

  console.log(`  TX: ${result.transactionHash}`);
  console.log(`  Height: ${result.height}`);
  console.log(`  Gas used: ${result.gasUsed}`);

  // Log events
  for (const event of result.events) {
    if (event.type === "wasm") {
      for (const attr of event.attributes) {
        console.log(`  [wasm] ${attr.key} = ${attr.value}`);
      }
    }
  }

  client.disconnect();
}

// ---------------------------------------------------------------------------
// Step 4: Query proof-callback events
// ---------------------------------------------------------------------------

async function queryCallbackEvents() {
  console.log(`\n=== Step 4: Query proof-callback events ===`);

  const client = await getHubClient();
  const result = await client.queryContractSmart(PROOF_CALLBACK_ADDRESS, {
    events: {},
  });

  console.log(`  Events: ${JSON.stringify(result, null, 2)}`);
  client.disconnect();
  return result;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

async function querySubscription(subscriptionId: number) {
  const client = await getHubClient();
  const result = await client.queryContractSmart(INTERCHAIN_EVENTS_ADDRESS, {
    subscription: { id: subscriptionId },
  });
  console.log(
    `  Subscription ${subscriptionId}: ${JSON.stringify(result, null, 2)}`
  );
  client.disconnect();
  return result;
}

async function queryAttestation(attestationId: string) {
  const client = await getNeutronClient();
  try {
    const result = await client.queryContractSmart(
      ATTESTATION_REGISTRY_ADDRESS,
      { get_attestation: { id: attestationId } }
    );
    console.log(`  Attestation "${attestationId}": ${JSON.stringify(result)}`);
    client.disconnect();
    return result;
  } catch (e: any) {
    console.log(`  Attestation "${attestationId}" not found`);
    client.disconnect();
    return null;
  }
}

async function findNeutronLightClient() {
  console.log(`\n=== Finding Neutron light client on Hub ===`);
  // This would need gRPC or REST queries to find the right client
  // For now, log instructions
  console.log(`  Run this command to find the light client ID:`);
  console.log(
    `  gaiad q ibc client states --node ${HUB_RPC} -o json | jq '.client_states[] | select(.client_state.chain_id == "neutron-1") | .client_id'`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs();
  const mnemonicHub = process.env.MNEMONIC_HUB || process.env.MNEMONIC;
  const mnemonicNeutron = process.env.MNEMONIC_NEUTRON || process.env.MNEMONIC;
  const queryOnly = flags["query-only"] === true;
  const submitOnly = flags["submit-proof"] === true;
  const attestationId = (flags["attestation-id"] as string) || "cosmos1abc";
  const clientId =
    (flags["client-id"] as string) || NEUTRON_LIGHT_CLIENT_ID;

  console.log("========================================");
  console.log("  Interchain Events - Test Flow");
  console.log("========================================");

  if (queryOnly) {
    console.log("\n--- Query Mode ---\n");

    await findNeutronLightClient();

    console.log(`\n--- Attestation on Neutron ---`);
    await queryAttestation(attestationId);

    console.log(`\n--- IAVL Key ---`);
    const iavlKey = buildAttestationIavlKey(attestationId);
    console.log(`  Hex: ${bytesToHex(iavlKey)}`);

    console.log(`\n--- Subscriptions on Hub ---`);
    const subId = parseInt((flags["subscription-id"] as string) || "1", 10);
    try {
      await querySubscription(subId);
    } catch {
      console.log(`  Subscription ${subId} not found`);
    }

    console.log(`\n--- Callback Events ---`);
    await queryCallbackEvents();

    return;
  }

  if (!mnemonicHub) {
    console.error(
      "\nError: MNEMONIC_HUB (or MNEMONIC) environment variable required for signing transactions."
    );
    console.error(
      "Usage: MNEMONIC_HUB='...' MNEMONIC_NEUTRON='...' npx tsx test-flow.ts [options]"
    );
    console.error("\nOptions:");
    console.error("  --query-only                  Read-only mode");
    console.error(
      "  --submit-proof                Submit proof for existing subscription"
    );
    console.error("  --subscription-id=N           Subscription ID (default: 1)");
    console.error(
      "  --attestation-id=ID           Attestation ID (default: cosmos1abc)"
    );
    console.error(
      "  --client-id=07-tendermint-N   IBC light client ID"
    );
    process.exit(1);
  }

  if (submitOnly) {
    const subId = parseInt((flags["subscription-id"] as string) || "1", 10);
    console.log(`\n--- Submit Proof Mode ---`);

    // Verify attestation exists
    console.log(`\n--- Checking attestation ---`);
    await queryAttestation(attestationId);

    // Submit proof
    await submitProof(mnemonicHub, subId, attestationId);

    // Verify callback
    await queryCallbackEvents();

    return;
  }

  // Full flow
  if (!mnemonicNeutron) {
    console.error(
      "\nError: MNEMONIC_NEUTRON required for writing attestations on Neutron."
    );
    process.exit(1);
  }

  console.log(`\n--- Full Test Flow ---`);
  console.log(`  Attestation ID: ${attestationId}`);
  console.log(`  IBC Client: ${clientId}`);

  // Validate client ID
  if (!clientId.startsWith("07-tendermint-")) {
    console.error("\nError: Invalid IBC light client ID:", clientId);
    process.exit(1);
  }

  // Step 1: Write attestation on Neutron
  await writeAttestation(mnemonicNeutron, attestationId, "approved");

  // Step 2: Create subscription on Hub
  const subscriptionId = await createSubscription(
    mnemonicHub,
    clientId,
    attestationId
  );

  // Wait a bit for the attestation to be committed
  console.log(`\n  Waiting 10s for blocks to finalize...`);
  await new Promise((r) => setTimeout(r, 10000));

  // Step 3: Fetch proof and submit on Hub
  await submitProof(mnemonicHub, subscriptionId, attestationId);

  // Step 4: Verify callback
  await queryCallbackEvents();

  console.log(`\n========================================`);
  console.log(`  Test Flow Complete!`);
  console.log(`========================================`);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message || e);
  process.exit(1);
});
