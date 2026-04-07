import { SigningCosmWasmClient, CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { toBase64 } from "@cosmjs/encoding";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HUB_RPC = "https://cosmos-rpc.polkachu.com";
const NEUTRON_RPC = "https://rpc-kralum.neutron-1.neutron.org";
const HUB_CHAIN_ID = "cosmoshub-4";
const NEUTRON_REVISION_NUMBER = 2;

const INTERCHAIN_EVENTS_CONTRACT =
  "cosmos1ul3v2sh4uqgvzr2c00dz2un6373hkunk0e0z9ay9x9td3uj7qdtqqggyqc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  id: number;
  creator: string;
  client_id: string;
  key_path: string[];
  watch_key: string; // base64-encoded IAVL key
  condition: any;
  callback_contract: string;
  callback_msg: string;
  status: string | { failed: { error: string } };
  created_at: number;
  expires_at: number | null;
}

export interface WatcherEvent {
  timestamp: number;
  subscription_id: number;
  type: "check" | "condition_met" | "proof_submitted" | "error";
  message: string;
  tx_hash?: string;
}

interface WatcherState {
  running: boolean;
  subscriptions: Subscription[];
  events: WatcherEvent[];
  lastCheck: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

const state: WatcherState = {
  running: false,
  subscriptions: [],
  events: [],
  lastCheck: null,
  error: null,
};

let pollTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// IAVL key building (mirrors scripts/iavl-key.ts)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Proof fetching & encoding (mirrors scripts/proof.ts)
// ---------------------------------------------------------------------------

async function fetchStateWithProof(iavlKeyHex: string) {
  const url = `${NEUTRON_RPC}/abci_query?path="store/wasm/key"&data=0x${iavlKeyHex}&prove=true`;
  const resp = await fetch(url);
  const json: any = await resp.json();
  const result = json.result.response;

  if (!result.value) return null;

  const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  return {
    key: fromBase64(result.key),
    value: fromBase64(result.value),
    height: parseInt(result.height, 10),
    proofOps: result.proofOps.ops.map((op: any) => ({
      type: op.type,
      data: fromBase64(op.data),
    })),
  };
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

function buildMerkleProof(proofOps: Array<{ data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const op of proofOps) {
    parts.push(new Uint8Array([0x0a]), encodeVarint(op.data.length), op.data);
  }
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

async function fetchAppHash(height: number): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await fetch(`${NEUTRON_RPC}/block?height=${height + 1}`);
    const json: any = await resp.json();
    const appHashHex = json.result?.block?.header?.app_hash;
    if (appHashHex) return hexToBytes(appHashHex);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Failed to fetch app_hash for block ${height + 1}`);
}

// ---------------------------------------------------------------------------
// Condition checking
// ---------------------------------------------------------------------------

function checkCondition(condition: any, valueBytes: Uint8Array): boolean {
  if (condition === "exists") return true;

  const valueStr = new TextDecoder().decode(valueBytes);

  if (condition.json_path_equals) {
    try {
      const json = JSON.parse(valueStr);
      let current: any = json;
      for (const segment of condition.json_path_equals.path.split(".")) {
        if (current && typeof current === "object" && segment in current) {
          current = current[segment];
        } else {
          return false;
        }
      }
      return String(current) === condition.json_path_equals.expected;
    } catch {
      return false;
    }
  }

  if (condition.equals) {
    const expected = condition.equals.expected;
    // expected is base64 in the subscription
    try {
      const expectedStr = atob(expected);
      return valueStr === expectedStr;
    } catch {
      return valueStr === expected;
    }
  }

  // For greater_than / less_than, simplified numeric check
  if (condition.greater_than) {
    try {
      const actual = parseFloat(valueStr.replace(/"/g, ""));
      const threshold = parseFloat(
        atob(condition.greater_than.threshold).replace(/"/g, "")
      );
      return actual > threshold;
    } catch {
      return false;
    }
  }

  if (condition.less_than) {
    try {
      const actual = parseFloat(valueStr.replace(/"/g, ""));
      const threshold = parseFloat(
        atob(condition.less_than.threshold).replace(/"/g, "")
      );
      return actual < threshold;
    } catch {
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core watcher loop
// ---------------------------------------------------------------------------

async function fetchActiveSubscriptions(): Promise<Subscription[]> {
  const client = await CosmWasmClient.connect(HUB_RPC);
  try {
    const result: any = await client.queryContractSmart(
      INTERCHAIN_EVENTS_CONTRACT,
      { list_subscriptions: { start_after: null, limit: 100 } }
    );
    return (result.subscriptions ?? []).filter(
      (s: Subscription) => s.status === "active"
    );
  } finally {
    client.disconnect();
  }
}

function addEvent(event: Omit<WatcherEvent, "timestamp">) {
  const full: WatcherEvent = { ...event, timestamp: Date.now() };
  state.events.unshift(full);
  // Keep last 100 events
  if (state.events.length > 100) state.events.length = 100;
}

async function processSubscription(sub: Subscription, mnemonic: string) {
  if (!sub.watch_key) {
    addEvent({
      subscription_id: sub.id,
      type: "check",
      message: `Subscription ${sub.id}: no watch_key, skipping`,
    });
    return;
  }

  // Decode base64 watch_key to hex for abci_query
  const watchKeyBytes = Uint8Array.from(atob(sub.watch_key), (c) => c.charCodeAt(0));
  const watchKeyHex = bytesToHex(watchKeyBytes);

  addEvent({
    subscription_id: sub.id,
    type: "check",
    message: `Checking subscription ${sub.id} (condition: ${JSON.stringify(sub.condition)})`,
  });

  try {
    // Fetch current state from remote chain
    const proof = await fetchStateWithProof(watchKeyHex);

    if (!proof) {
      addEvent({
        subscription_id: sub.id,
        type: "check",
        message: `Key not found on remote chain`,
      });
      return;
    }

    // Check if condition is met
    if (!checkCondition(sub.condition, proof.value)) {
      addEvent({
        subscription_id: sub.id,
        type: "check",
        message: `Condition not met (value: ${new TextDecoder().decode(proof.value).slice(0, 80)}...)`,
      });
      return;
    }

    addEvent({
      subscription_id: sub.id,
      type: "condition_met",
      message: `Condition met at height ${proof.height}! Submitting proof...`,
    });

    // Fetch app hash and build merkle proof
    const appHash = await fetchAppHash(proof.height);
    const merkleProof = buildMerkleProof(proof.proofOps);

    // Sign and submit
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: "cosmos",
    });
    const [account] = await wallet.getAccounts();
    const client = await SigningCosmWasmClient.connectWithSigner(HUB_RPC, wallet, {
      gasPrice: GasPrice.fromString("0.005uatom"),
    });

    const msg = {
      submit_proof: {
        subscription_id: sub.id,
        height: {
          revision_number: NEUTRON_REVISION_NUMBER,
          revision_height: proof.height,
        },
        app_hash: toBase64(appHash),
        proof: toBase64(merkleProof),
        key: toBase64(proof.key),
        value: toBase64(proof.value),
      },
    };

    const result = await client.execute(
      account.address,
      INTERCHAIN_EVENTS_CONTRACT,
      msg,
      "auto"
    );

    client.disconnect();

    addEvent({
      subscription_id: sub.id,
      type: "proof_submitted",
      message: `Proof submitted! TX: ${result.transactionHash}`,
      tx_hash: result.transactionHash,
    });
  } catch (e: any) {
    addEvent({
      subscription_id: sub.id,
      type: "error",
      message: `Error: ${e.message || String(e)}`,
    });
  }
}

async function pollOnce() {
  const mnemonic = process.env.WATCHER_MNEMONIC;

  try {
    state.subscriptions = await fetchActiveSubscriptions();
    state.lastCheck = Date.now();
    state.error = null;

    if (state.subscriptions.length === 0) return;

    if (!mnemonic) {
      state.error = "WATCHER_MNEMONIC not set — watching in read-only mode";
      return;
    }

    for (const sub of state.subscriptions) {
      await processSubscription(sub, mnemonic);
    }
  } catch (e: any) {
    state.error = e.message || String(e);
    addEvent({
      subscription_id: 0,
      type: "error",
      message: `Poll error: ${state.error}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startWatcher(intervalMs = 30_000) {
  if (state.running) return;
  state.running = true;

  console.log(`[watcher] Starting (poll interval: ${intervalMs}ms)`);

  const tick = async () => {
    if (!state.running) return;
    await pollOnce();
    if (state.running) {
      pollTimer = setTimeout(tick, intervalMs);
    }
  };

  // Initial poll after 5s to let the server start
  pollTimer = setTimeout(tick, 5000);
}

export function stopWatcher() {
  state.running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  console.log("[watcher] Stopped");
}

export function getWatcherState(): WatcherState {
  return { ...state };
}

export async function submitProofForSubscription(
  subscriptionId: number,
  iavlKeyHex: string
): Promise<{ txHash: string }> {
  const mnemonic = process.env.WATCHER_MNEMONIC;
  if (!mnemonic) throw new Error("WATCHER_MNEMONIC not set");

  addEvent({
    subscription_id: subscriptionId,
    type: "check",
    message: `Fetching proof for subscription ${subscriptionId}...`,
  });

  // Fetch state with proof
  const proof = await fetchStateWithProof(iavlKeyHex);
  if (!proof) throw new Error("State not found at this key");

  // Check condition
  const sub = state.subscriptions.find((s) => s.id === subscriptionId);
  if (sub && !checkCondition(sub.condition, proof.value)) {
    addEvent({
      subscription_id: subscriptionId,
      type: "check",
      message: `Condition not met for subscription ${subscriptionId}`,
    });
    throw new Error("Condition not met");
  }

  addEvent({
    subscription_id: subscriptionId,
    type: "condition_met",
    message: `Condition met! Submitting proof at height ${proof.height}...`,
  });

  // Fetch app hash
  const appHash = await fetchAppHash(proof.height);

  // Build merkle proof
  const merkleProof = buildMerkleProof(proof.proofOps);

  // Sign and submit
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "cosmos",
  });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(HUB_RPC, wallet, {
    gasPrice: GasPrice.fromString("0.005uatom"),
  });

  const msg = {
    submit_proof: {
      subscription_id: subscriptionId,
      height: {
        revision_number: NEUTRON_REVISION_NUMBER,
        revision_height: proof.height,
      },
      app_hash: toBase64(appHash),
      proof: toBase64(merkleProof),
      key: toBase64(proof.key),
      value: toBase64(proof.value),
    },
  };

  const result = await client.execute(
    account.address,
    INTERCHAIN_EVENTS_CONTRACT,
    msg,
    "auto"
  );

  client.disconnect();

  addEvent({
    subscription_id: subscriptionId,
    type: "proof_submitted",
    message: `Proof submitted! TX: ${result.transactionHash}`,
    tx_hash: result.transactionHash,
  });

  return { txHash: result.transactionHash };
}
