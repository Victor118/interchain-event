export interface Chain {
  id: string
  name: string
  chainId: string
  rpc: string
  rest: string
  modules: string[]
}

const chains: Chain[] = [
  {
    id: 'neutron',
    name: 'Neutron',
    chainId: 'neutron-1',
    rpc: 'https://rpc-kralum.neutron-1.neutron.org',
    rest: 'https://rest-kralum.neutron-1.neutron.org',
    modules: ['bank', 'wasm', 'staking', 'gov', 'ibc', 'distribution', 'slashing', 'mint', 'auth', 'dex', 'cron', 'interchaintxs', 'interchainqueries', 'feeburner', 'tokenfactory'],
  },
]

export function useChains() {
  const selectedChain = useState<Chain | null>('selectedChain', () => chains[0])

  function selectChain(chainId: string) {
    selectedChain.value = chains.find(c => c.id === chainId) ?? null
  }

  return {
    chains,
    selectedChain,
    selectChain,
  }
}
