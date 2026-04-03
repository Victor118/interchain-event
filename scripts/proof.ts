// Fetch Merkle proofs from Neutron and convert to MerkleProof format.

import { toBase64, fromBase64 } from "@cosmjs/encoding";
import * as protobuf from "protobufjs";
import { NEUTRON_RPC } from "./config.js";
import { bytesToHex } from "./iavl-key.js";

/**
 * Result of querying state with proof from Neutron.
 */
export interface ProofResult {
  key: Uint8Array;
  value: Uint8Array;
  height: number;
  /** ProofOps from abci_query, each op.data is a CommitmentProof */
  proofOps: Array<{ type: string; key: Uint8Array; data: Uint8Array }>;
}

/**
 * Query state with Merkle proof via abci_query on Neutron.
 */
export async function fetchStateWithProof(
  iavlKeyHex: string,
  height?: number
): Promise<ProofResult> {
  let url = `${NEUTRON_RPC}/abci_query?path="store/wasm/key"&data=0x${iavlKeyHex}&prove=true`;
  if (height) {
    url += `&height=${height}`;
  }

  console.log(`Querying Neutron abci_query...`);
  const resp = await fetch(url);
  const json = await resp.json();

  const result = json.result.response;

  if (result.code !== 0 && result.code !== undefined) {
    throw new Error(`abci_query failed: code=${result.code} log=${result.log}`);
  }

  if (!result.value) {
    throw new Error(
      "abci_query returned no value - the attestation may not exist at this height"
    );
  }

  const key = fromBase64(result.key);
  const value = fromBase64(result.value);
  const proofHeight = parseInt(result.height, 10);

  const proofOps = result.proofOps.ops.map(
    (op: { type: string; key: string; data: string }) => ({
      type: op.type,
      key: fromBase64(op.key),
      data: fromBase64(op.data),
    })
  );

  console.log(`  Height: ${proofHeight}`);
  console.log(`  Key (hex): ${bytesToHex(key)}`);
  console.log(`  Value length: ${value.length} bytes`);
  console.log(`  Proof ops: ${proofOps.length}`);
  for (const op of proofOps) {
    console.log(`    - type: ${op.type}, data: ${op.data.length} bytes`);
  }

  return { key, value, height: proofHeight, proofOps };
}

/**
 * Build a MerkleProof protobuf from ProofOps.
 *
 * The contract expects ibc.core.commitment.v1.MerkleProof:
 *   message MerkleProof { repeated ics23.CommitmentProof proofs = 1; }
 *
 * The abci_query returns ProofOps where each op.data is already a
 * serialized ics23.CommitmentProof. We just wrap them.
 */
export function buildMerkleProof(
  proofOps: Array<{ type: string; data: Uint8Array }>
): Uint8Array {
  // MerkleProof is a simple wrapper: field 1 (repeated bytes) = each CommitmentProof
  // We encode it manually since the structure is trivial:
  // For each proof: tag (field 1, wire type 2 = length-delimited) + length + data
  const parts: Uint8Array[] = [];

  for (const op of proofOps) {
    // field 1, wire type 2 => tag byte = (1 << 3) | 2 = 0x0a
    const tag = new Uint8Array([0x0a]);
    const len = encodeVarint(op.data.length);
    parts.push(tag, len, op.data);
  }

  // Concatenate all parts
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }

  return result;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

/**
 * Fetch the AppHash from a Neutron block header at a given height.
 * The app_hash in the header at height H is the state root AFTER executing block H.
 * However, the proof at height H is against the state BEFORE block H+1,
 * so we need the app_hash from the block at height H+1.
 */
export async function fetchAppHash(height: number): Promise<Uint8Array> {
  // The app_hash in block N+1's header corresponds to the state after block N
  const targetHeight = height + 1;
  console.log(`  Fetching app_hash from block ${targetHeight} header...`);

  let appHashHex: string | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await fetch(`${NEUTRON_RPC}/block?height=${targetHeight}`);
    const json = await resp.json();
    appHashHex = json.result?.block?.header?.app_hash;
    if (appHashHex) break;
    console.log(`  Block ${targetHeight} not ready yet, waiting 2s...`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!appHashHex) {
    throw new Error(`Failed to fetch app_hash for block ${targetHeight}`);
  }

  console.log(`  AppHash: ${appHashHex}`);

  return hexToUint8Array(appHashHex);
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert proof result to the base64-encoded values needed for SubmitProof.
 */
export async function encodeProofForContract(proof: ProofResult) {
  const merkleProof = buildMerkleProof(proof.proofOps);
  const appHash = await fetchAppHash(proof.height);

  return {
    app_hash: toBase64(appHash),
    proof: toBase64(merkleProof),
    key: toBase64(proof.key),
    value: toBase64(proof.value),
  };
}
