// Build IAVL keys matching cw-storage-plus encoding.
//
// The wasm module stores contract state under:
//   \x03 + <contract_address_bytes_32> + <cw-storage-plus key>
//
// cw-storage-plus Map keys are encoded as:
//   <namespace_len_2bytes_BE> + <namespace> + <map_key>

import { ATTESTATION_REGISTRY_ADDR_HEX } from "./config.js";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Build the cw-storage-plus key for a Map<&str, V> entry.
 * Encoding: 2-byte big-endian namespace length + namespace bytes + key bytes
 */
function cwStoragePlusMapKey(namespace: string, mapKey: string): Uint8Array {
  const nsBytes = textToBytes(namespace);
  const keyBytes = textToBytes(mapKey);
  const lenPrefix = new Uint8Array(2);
  lenPrefix[0] = (nsBytes.length >> 8) & 0xff;
  lenPrefix[1] = nsBytes.length & 0xff;
  return concatBytes(lenPrefix, nsBytes, keyBytes);
}

/**
 * Build the full IAVL key for an attestation in the wasm module.
 * Format: \x03 + contract_addr_32bytes + cw_storage_plus_key
 */
export function buildAttestationIavlKey(attestationId: string): Uint8Array {
  const prefix = new Uint8Array([0x03]);
  const contractAddr = hexToBytes(ATTESTATION_REGISTRY_ADDR_HEX);
  const storageKey = cwStoragePlusMapKey("attestations", attestationId);
  return concatBytes(prefix, contractAddr, storageKey);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
