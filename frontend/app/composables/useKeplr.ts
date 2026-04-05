import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";

const HUB_CHAIN_ID = "cosmoshub-4";
const HUB_RPC = "https://cosmos-rpc.polkachu.com";

const INTERCHAIN_EVENTS_CONTRACT =
  "cosmos1e96r45we8w204g5hnh3phlft9szxzkhjqqrf6lu82c5hdfxdz66q52cqg0";

export function useKeplr() {
  const address = useState<string | null>("keplrAddress", () => null);
  const connected = useState<boolean>("keplrConnected", () => false);
  const error = useState<string | null>("keplrError", () => null);

  async function connect() {
    error.value = null;

    if (typeof window === "undefined" || !(window as any).keplr) {
      error.value = "Keplr not found. Please install the Keplr extension.";
      return;
    }

    try {
      const keplr = (window as any).keplr;
      await keplr.enable(HUB_CHAIN_ID);
      const offlineSigner = keplr.getOfflineSigner(HUB_CHAIN_ID);
      const accounts = await offlineSigner.getAccounts();
      address.value = accounts[0].address;
      connected.value = true;
    } catch (e: any) {
      error.value = e.message || "Failed to connect to Keplr";
    }
  }

  async function executeSubscribe(msg: Record<string, any>): Promise<{
    txHash: string;
    subscriptionId?: number;
  }> {
    if (!connected.value) throw new Error("Keplr not connected");

    const keplr = (window as any).keplr;
    const offlineSigner = keplr.getOfflineSigner(HUB_CHAIN_ID);
    const client = await SigningCosmWasmClient.connectWithSigner(
      HUB_RPC,
      offlineSigner,
      { gasPrice: GasPrice.fromString("0.005uatom") }
    );

    const result = await client.execute(
      address.value!,
      INTERCHAIN_EVENTS_CONTRACT,
      msg,
      "auto"
    );

    // Extract subscription_id from events
    const subIdAttr = result.events
      .flatMap((e: any) => e.attributes)
      .find((a: any) => a.key === "subscription_id");
    const subscriptionId = subIdAttr
      ? parseInt(subIdAttr.value, 10)
      : undefined;

    client.disconnect();

    return { txHash: result.transactionHash, subscriptionId };
  }

  async function queryContract(queryMsg: Record<string, any>): Promise<any> {
    const { CosmWasmClient } = await import("@cosmjs/cosmwasm-stargate");
    const client = await CosmWasmClient.connect(HUB_RPC);
    const result = await client.queryContractSmart(
      INTERCHAIN_EVENTS_CONTRACT,
      queryMsg
    );
    client.disconnect();
    return result;
  }

  return {
    address,
    connected,
    error,
    connect,
    executeSubscribe,
    queryContract,
    INTERCHAIN_EVENTS_CONTRACT,
  };
}
