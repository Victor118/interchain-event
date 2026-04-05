// Contract addresses and chain configuration

export const HUB_RPC = "https://cosmos-rpc.polkachu.com:443";
export const NEUTRON_RPC = "https://rpc-kralum.neutron-1.neutron.org:443";

export const HUB_CHAIN_ID = "cosmoshub-4";
export const NEUTRON_CHAIN_ID = "neutron-1";
export const NEUTRON_REVISION_NUMBER = 2;

// IBC light client IDs for Neutron on Hub
// Found via: /ibc/core/client/v1/client_states filtered for chain_id "neutron-1"
export const NEUTRON_LIGHT_CLIENT_ID = "07-tendermint-1119";

export const INTERCHAIN_EVENTS_ADDRESS =
  "cosmos1e96r45we8w204g5hnh3phlft9szxzkhjqqrf6lu82c5hdfxdz66q52cqg0";
export const PROOF_CALLBACK_ADDRESS =
  "cosmos1ej8k44crydrg5qx3jd2g49va6k05mzfq7hfn0zpklqupvnu8nfwsm0ev57";
export const ATTESTATION_REGISTRY_ADDRESS =
  "neutron1dhw2cyurukdvl9v36lkmd7p900u89cdalytv5a7tluzhkevd89wsda4wjl";

// Hex bytes of the attestation-registry contract address (32 bytes, bech32-decoded)
export const ATTESTATION_REGISTRY_ADDR_HEX =
  "6ddcac1383e59acf9591d7edb6f8257bf872e1bdf916ca77cbff057b658d395d";
