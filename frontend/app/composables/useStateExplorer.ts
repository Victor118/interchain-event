export interface StateNode {
  key: string
  value: string | null
  module: string
  path: string[]
  hasChildren: boolean
  children: StateNode[]
  expanded: boolean
  loading: boolean
  nextPageKey: string | null
  isLoadMore?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  /** Real Merkle store name for subscription (e.g. "bank", "wasm") */
  storeName?: string
  /** Real IAVL key (hex) for subscription proof */
  storeKey?: string
}

type ModuleFetcher = (rest: string, node: StateNode, pageKey?: string) => Promise<{ nodes: StateNode[]; nextKey: string | null }>

/** Search function: given a key typed by the user, query REST and return found value or null */
type KeySearcher = (rest: string, node: StateNode, key: string) => Promise<{ found: boolean; value: string | null; children?: StateNode[] }>

const PAGE_SIZE = 30

interface LeafOpts { storeName?: string; storeKey?: string }
interface FolderOpts { searchable?: boolean; searchPlaceholder?: string; storeName?: string; storeKey?: string }

function makeLeaf(module: string, path: string[], key: string, value: string, opts?: LeafOpts): StateNode {
  return { key, value, module, path: [...path, key], hasChildren: false, children: [], expanded: false, loading: false, nextPageKey: null, ...opts }
}

function makeFolder(module: string, path: string[], key: string, opts?: FolderOpts): StateNode {
  return { key, value: null, module, path: [...path, key], hasChildren: true, children: [], expanded: false, loading: false, nextPageKey: null, ...opts }
}

function makeLoadMore(module: string, path: string[]): StateNode {
  return { key: '__ load_more __', value: null, module, path, hasChildren: false, children: [], expanded: false, loading: false, nextPageKey: null, isLoadMore: true }
}

function paginated(nodes: StateNode[], nextKey: string | null): { nodes: StateNode[]; nextKey: string | null } {
  return { nodes, nextKey }
}

/** Encode a string to hex */
function toHex(str: string): string {
  return Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Decode hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

/**
 * Decode a wasm contract state key from hex into a human-readable form.
 *
 * cw-storage-plus Map keys are encoded as:
 *   <2-byte BE namespace length> + <namespace> + <map_key>
 *
 * cw-storage-plus Item keys are just the namespace bytes (no length prefix).
 *
 * We try to extract the namespace and map key as UTF-8.
 * If the bytes aren't valid UTF-8 we fall back to a hex representation.
 */
function decodeWasmStateKey(hex: string): string {
  try {
    const bytes = hexToBytes(hex)
    const decoder = new TextDecoder('utf-8', { fatal: true })

    // Try Map encoding: first 2 bytes = namespace length
    if (bytes.length >= 2) {
      const nsLen = (bytes[0] << 8) | bytes[1]
      if (nsLen > 0 && nsLen < bytes.length - 2) {
        const nsBytes = bytes.slice(2, 2 + nsLen)
        const keyBytes = bytes.slice(2 + nsLen)
        try {
          const ns = decoder.decode(nsBytes)
          // Only accept if namespace looks like printable ASCII
          if (/^[\x20-\x7e]+$/.test(ns)) {
            if (keyBytes.length === 0) return ns
            try {
              const mapKey = decoder.decode(keyBytes)
              if (/^[\x20-\x7e]+$/.test(mapKey)) return `${ns}::${mapKey}`
              // Map key is binary, show as hex
              return `${ns}::0x${Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`
            } catch {
              return `${ns}::0x${Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`
            }
          }
        } catch { /* not valid UTF-8 namespace */ }
      }
    }

    // Try Item encoding: entire key is a namespace string
    try {
      const str = decoder.decode(bytes)
      if (/^[\x20-\x7e]+$/.test(str)) return str
    } catch { /* not valid UTF-8 */ }

    // Fallback: hex
    return `0x${hex}`
  } catch {
    return `0x${hex}`
  }
}

/**
 * Build the IAVL key for wasm contract storage:
 * \x03 + len(contract_addr) as 2 bytes + contract_addr_bytes + storage_key_bytes
 * In practice for the Merkle proof the key_path is ["wasm"] and the key is the raw bytes.
 * We store the hex representation for display / subscription creation.
 */
function wasmStoreKey(contractAddr: string, storageKeyHex: string): string {
  // \x03 prefix + contract address as UTF-8 + raw storage key
  const prefix = '03'
  const addrHex = toHex(contractAddr)
  // cw-storage-plus uses 2-byte big-endian length prefix for the namespace
  const addrLen = (addrHex.length / 2).toString(16).padStart(4, '0')
  return prefix + addrLen + addrHex + storageKeyHex
}

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------
async function fetchBank(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('bank', node.path, 'supply'),
      makeFolder('bank', node.path, 'balances', { searchable: true, searchPlaceholder: 'Enter address (neutron1...)' }),
    ], null)
  }
  if (node.path.includes('supply')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/cosmos/bank/v1beta1/supply`, { query })
    const nodes = (res.supply ?? []).map((coin: any) =>
      makeLeaf('bank', node.path, coin.denom, coin.amount, {
        storeName: 'bank',
        storeKey: toHex('supply/' + coin.denom),
      })
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  return paginated([], null)
}

async function searchBank(rest: string, node: StateNode, key: string): Promise<{ found: boolean; value: string | null; children?: StateNode[] }> {
  // key = address → fetch balances
  if (node.path.includes('balances')) {
    try {
      const res = await $fetch<any>(`${rest}/cosmos/bank/v1beta1/balances/${key}`)
      const balances = res.balances ?? []
      if (balances.length > 0) {
        const children = balances.map((coin: any) =>
          makeLeaf('bank', [...node.path, key], coin.denom, coin.amount, {
            storeName: 'bank',
            storeKey: toHex('balances/' + key + '/' + coin.denom),
          })
        )
        return { found: true, value: `${balances.length} tokens`, children }
      }
      return { found: false, value: null }
    } catch {
      return { found: false, value: null }
    }
  }
  return { found: false, value: null }
}

// ---------------------------------------------------------------------------
// Staking
// ---------------------------------------------------------------------------
async function fetchStaking(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('staking', node.path, 'validators'),
      makeFolder('staking', node.path, 'params'),
    ], null)
  }
  if (node.path.includes('validators')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/cosmos/staking/v1beta1/validators`, { query })
    const nodes = (res.validators ?? []).map((v: any) =>
      makeLeaf('staking', node.path, v.description?.moniker ?? v.operator_address, JSON.stringify({ tokens: v.tokens, status: v.status, commission: v.commission?.commission_rates?.rate }))
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/staking/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('staking', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Gov
// ---------------------------------------------------------------------------
async function fetchGov(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('gov', node.path, 'proposals'),
      makeFolder('gov', node.path, 'params'),
    ], null)
  }
  if (node.path.includes('proposals')) {
    const query: any = { 'pagination.limit': PAGE_SIZE, 'pagination.reverse': true }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/cosmos/gov/v1beta1/proposals`, { query })
    const nodes = (res.proposals ?? []).map((p: any) =>
      makeLeaf('gov', node.path, `#${p.proposal_id ?? p.id} ${p.content?.title ?? p.title ?? ''}`, p.status)
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/gov/v1beta1/params/tallying`)
    return paginated(Object.entries(res.params ?? res.tally_params ?? {}).map(([k, v]) =>
      makeLeaf('gov', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// IBC
// ---------------------------------------------------------------------------
async function fetchIbc(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('ibc', node.path, 'clients'),
      makeFolder('ibc', node.path, 'connections'),
      makeFolder('ibc', node.path, 'channels'),
    ], null)
  }
  if (node.path.includes('clients')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/ibc/core/client/v1/client_states`, { query })
    const nodes = (res.client_states ?? []).map((cs: any) =>
      makeLeaf('ibc', node.path, cs.client_id, cs.client_state?.chain_id ?? 'unknown')
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  if (node.path.includes('connections')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/ibc/core/connection/v1/connections`, { query })
    const nodes = (res.connections ?? []).map((c: any) =>
      makeLeaf('ibc', node.path, c.id, `client: ${c.client_id}, state: ${c.state}`)
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  if (node.path.includes('channels')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/ibc/core/channel/v1/channels`, { query })
    const nodes = (res.channels ?? []).map((ch: any) =>
      makeLeaf('ibc', node.path, `${ch.port_id}/${ch.channel_id}`, `state: ${ch.state}, counterparty: ${ch.counterparty?.channel_id}`)
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Wasm
// ---------------------------------------------------------------------------
async function fetchWasm(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('wasm', node.path, 'codes'),
      makeFolder('wasm', node.path, 'contracts', { searchable: true, searchPlaceholder: 'Enter contract address (neutron1...)' }),
    ], null)
  }
  if (node.path.includes('codes') && node.path.length === 2) {
    const query: any = { 'pagination.limit': PAGE_SIZE, 'pagination.reverse': true }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/cosmwasm/wasm/v1/code`, { query })
    const nodes = (res.code_infos ?? []).map((c: any) =>
      makeLeaf('wasm', node.path, `code ${c.code_id}`, `creator: ${c.creator}`)
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  return paginated([], null)
}

async function searchWasm(rest: string, node: StateNode, key: string): Promise<{ found: boolean; value: string | null; children?: StateNode[] }> {
  if (node.path.includes('contracts')) {
    try {
      // First get contract info
      const info = await $fetch<any>(`${rest}/cosmwasm/wasm/v1/contract/${key}`)
      const contract = info.contract_info ?? {}

      // Then get contract state
      const stateRes = await $fetch<any>(`${rest}/cosmwasm/wasm/v1/contract/${key}/state`, { query: { 'pagination.limit': PAGE_SIZE } })
      const models = stateRes.models ?? []

      const children = models.map((m: any) => {
        // m.key from REST is hex-encoded, m.value is base64-encoded
        const rawKeyHex = m.key
        const decodedKey = decodeWasmStateKey(rawKeyHex)
        let decodedValue = m.value
        try { decodedValue = atob(m.value) } catch { /* keep raw */ }
        return makeLeaf('wasm', [...node.path, key], decodedKey, decodedValue, {
          storeName: 'wasm',
          storeKey: wasmStoreKey(key, rawKeyHex),
        })
      })

      const label = contract.label ? `${contract.label} (code ${contract.code_id})` : `code ${contract.code_id}`
      return { found: true, value: label, children }
    } catch {
      return { found: false, value: null }
    }
  }
  return { found: false, value: null }
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------
async function fetchDistribution(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('distribution', node.path, 'params'),
      makeFolder('distribution', node.path, 'community_pool'),
    ], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/distribution/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('distribution', node.path, k, String(v))
    ), null)
  }
  if (node.path.includes('community_pool')) {
    const res = await $fetch<any>(`${rest}/cosmos/distribution/v1beta1/community_pool`)
    return paginated((res.pool ?? []).map((coin: any) =>
      makeLeaf('distribution', node.path, coin.denom, coin.amount)
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------
async function fetchMint(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('mint', node.path, 'params'),
      makeFolder('mint', node.path, 'inflation'),
    ], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/mint/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('mint', node.path, k, String(v))
    ), null)
  }
  if (node.path.includes('inflation')) {
    const res = await $fetch<any>(`${rest}/cosmos/mint/v1beta1/inflation`)
    return paginated([makeLeaf('mint', node.path, 'inflation', res.inflation ?? 'N/A')], null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Slashing
// ---------------------------------------------------------------------------
async function fetchSlashing(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('slashing', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/slashing/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('slashing', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function fetchAuth(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('auth', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/cosmos/auth/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('auth', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Neutron: Interchain Queries
// ---------------------------------------------------------------------------
async function fetchInterchainQueries(rest: string, node: StateNode, pageKey?: string): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('interchainqueries', node.path, 'registered_queries'),
      makeFolder('interchainqueries', node.path, 'params'),
    ], null)
  }
  if (node.path.includes('registered_queries')) {
    const query: any = { 'pagination.limit': PAGE_SIZE }
    if (pageKey) query['pagination.key'] = pageKey
    const res = await $fetch<any>(`${rest}/neutron/interchainqueries/registered_queries`, { query })
    const nodes = (res.registered_queries ?? []).map((q: any) =>
      makeLeaf('interchainqueries', node.path, `#${q.id} (${q.query_type})`, JSON.stringify({ owner: q.owner, keys: q.keys }))
    )
    return paginated(nodes, res.pagination?.next_key || null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/neutron/interchainqueries/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('interchainqueries', node.path, k, JSON.stringify(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Neutron: Interchain TXs
// ---------------------------------------------------------------------------
async function fetchInterchainTxs(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('interchaintxs', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/neutron/interchaintxs/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('interchaintxs', node.path, k, JSON.stringify(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Neutron: Fee Burner
// ---------------------------------------------------------------------------
async function fetchFeeBurner(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('feeburner', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/neutron/feeburner/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('feeburner', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Neutron: Token Factory
// ---------------------------------------------------------------------------
async function fetchTokenFactory(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([
      makeFolder('tokenfactory', node.path, 'params'),
      makeFolder('tokenfactory', node.path, 'denoms_from_creator', { searchable: true, searchPlaceholder: 'Enter creator address (neutron1...)' }),
    ], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/osmosis/tokenfactory/v1beta1/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('tokenfactory', node.path, k, JSON.stringify(v))
    ), null)
  }
  return paginated([], null)
}

async function searchTokenFactory(rest: string, node: StateNode, key: string): Promise<{ found: boolean; value: string | null; children?: StateNode[] }> {
  if (node.path.includes('denoms_from_creator')) {
    try {
      const res = await $fetch<any>(`${rest}/osmosis/tokenfactory/v1beta1/denoms_from_creator/${key}`)
      const denoms = res.denoms ?? []
      if (denoms.length > 0) {
        const children = denoms.map((d: string) =>
          makeLeaf('tokenfactory', [...node.path, key], d, d)
        )
        return { found: true, value: `${denoms.length} denoms`, children }
      }
      return { found: false, value: null }
    } catch {
      return { found: false, value: null }
    }
  }
  return { found: false, value: null }
}

// ---------------------------------------------------------------------------
// Neutron: Cron (params only, no list endpoint via REST)
// ---------------------------------------------------------------------------
async function fetchCron(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('cron', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/neutron/cron/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('cron', node.path, k, String(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Neutron: DEX (params only, no list endpoint via REST)
// ---------------------------------------------------------------------------
async function fetchDex(rest: string, node: StateNode): Promise<{ nodes: StateNode[]; nextKey: string | null }> {
  if (node.path.length === 1) {
    return paginated([makeFolder('dex', node.path, 'params')], null)
  }
  if (node.path.includes('params')) {
    const res = await $fetch<any>(`${rest}/neutron/dex/params`)
    return paginated(Object.entries(res.params ?? {}).map(([k, v]) =>
      makeLeaf('dex', node.path, k, JSON.stringify(v))
    ), null)
  }
  return paginated([], null)
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------
const fetchers: Record<string, ModuleFetcher> = {
  bank: fetchBank,
  staking: fetchStaking,
  gov: fetchGov,
  ibc: fetchIbc,
  wasm: fetchWasm,
  distribution: fetchDistribution,
  mint: fetchMint,
  slashing: fetchSlashing,
  auth: fetchAuth,
  interchainqueries: fetchInterchainQueries,
  interchaintxs: fetchInterchainTxs,
  feeburner: fetchFeeBurner,
  tokenfactory: fetchTokenFactory,
  cron: fetchCron,
  dex: fetchDex,
}

const searchers: Record<string, KeySearcher> = {
  bank: searchBank,
  wasm: searchWasm,
  tokenfactory: searchTokenFactory,
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------
export function useStateExplorer() {
  const tree = useState<StateNode[]>('stateTree', () => [])
  const error = useState<string | null>('explorerError', () => null)

  function setModules(modules: string[]) {
    tree.value = modules.map(mod => makeFolder(mod, [], mod))
    error.value = null
  }

  async function fetchChildren(node: StateNode, rest: string, pageKey?: string) {
    const fetcher = fetchers[node.module]
    if (!fetcher) return

    const { nodes, nextKey } = await fetcher(rest, node, pageKey)
    node.nextPageKey = nextKey

    node.children = node.children.filter(c => !c.isLoadMore)

    if (pageKey) {
      node.children.push(...nodes)
    } else {
      node.children = nodes
    }

    if (nextKey) {
      node.children.push(makeLoadMore(node.module, node.path))
    }

    if (node.children.length === 0) {
      node.hasChildren = false
    }
  }

  async function toggleNode(node: StateNode, rest: string) {
    if (node.expanded) {
      node.expanded = false
      return
    }

    node.expanded = true

    if (node.children.length === 0 && node.hasChildren) {
      node.loading = true
      error.value = null
      try {
        await fetchChildren(node, rest)
      } catch (e: any) {
        error.value = `${node.module}: ${e.message ?? e}`
      } finally {
        node.loading = false
      }
    }
  }

  async function loadMore(parentNode: StateNode, rest: string) {
    if (!parentNode.nextPageKey) return

    const loadMoreNode = parentNode.children.find(c => c.isLoadMore)
    if (loadMoreNode) loadMoreNode.loading = true

    error.value = null
    try {
      await fetchChildren(parentNode, rest, parentNode.nextPageKey)
    } catch (e: any) {
      error.value = `${parentNode.module}: ${e.message ?? e}`
    } finally {
      if (loadMoreNode) loadMoreNode.loading = false
    }
  }

  async function searchKey(node: StateNode, rest: string, key: string): Promise<{ found: boolean; value: string | null; children?: StateNode[] }> {
    // First check loaded children
    const existing = node.children.find(c => !c.isLoadMore && c.key === key)
    if (existing) {
      return { found: true, value: existing.value }
    }

    // Use module-specific searcher if available
    const searcher = searchers[node.module]
    if (searcher) {
      return await searcher(rest, node, key)
    }

    return { found: false, value: null }
  }

  return {
    tree,
    error,
    setModules,
    toggleNode,
    loadMore,
    searchKey,
  }
}
