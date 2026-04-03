<template>
  <div class="explorer">
    <!-- Left sidebar: chain list -->
    <aside class="explorer-sidebar">
      <div class="sidebar-title">Chains</div>
      <ul class="chain-list">
        <li
          v-for="chain in chains"
          :key="chain.id"
          class="chain-item"
          :class="{ 'chain-item--active': selectedChain?.id === chain.id }"
          @click="onSelectChain(chain.id)"
        >
          <span class="chain-dot" />
          <span>{{ chain.name }}</span>
          <span class="chain-id">{{ chain.chainId }}</span>
        </li>
      </ul>
    </aside>

    <!-- Main area: state tree -->
    <section class="explorer-main">
      <div v-if="selectedChain" class="explorer-header">
        <span class="chain-label">{{ selectedChain.name }}</span>
        <span class="chain-rpc">{{ selectedChain.rpc }}</span>
      </div>

      <div v-if="error" class="explorer-error">{{ error }}</div>

      <div v-if="selectedChain" class="tree-container">
        <TreeNode
          v-for="node in tree"
          :key="node.key"
          :node="node"
          :depth="0"
          :rest="selectedChain.rest"
        />
      </div>

      <div v-else class="explorer-empty">
        Select a chain to explore its state.
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
const { chains, selectedChain, selectChain } = useChains()
const { tree, error, setModules } = useStateExplorer()

function onSelectChain(chainId: string) {
  selectChain(chainId)
  if (selectedChain.value) {
    setModules(selectedChain.value.modules)
  }
}

// Init with default chain
onMounted(() => {
  if (selectedChain.value) {
    setModules(selectedChain.value.modules)
  }
})
</script>

<style scoped>
.explorer {
  display: flex;
  height: 100%;
}

.explorer-sidebar {
  width: 220px;
  border-right: 1px solid var(--border);
  background: var(--bg-surface);
  padding: 12px 0;
  flex-shrink: 0;
  overflow-y: auto;
}

.sidebar-title {
  padding: 0 16px 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.chain-list {
  list-style: none;
}

.chain-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
}

.chain-item:hover {
  background: var(--bg-hover);
}

.chain-item--active {
  background: var(--accent-dim);
  color: var(--accent);
}

.chain-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.chain-id {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.explorer-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.explorer-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.chain-label {
  font-weight: 600;
  font-size: 15px;
}

.chain-rpc {
  font-size: 12px;
  color: var(--text-muted);
}

.explorer-error {
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #dc354522;
  border: 1px solid #dc354555;
  border-radius: 6px;
  color: #ff6b6b;
  font-size: 12px;
}

.explorer-empty {
  color: var(--text-muted);
  text-align: center;
  margin-top: 80px;
}

.tree-container {
  font-size: 13px;
}
</style>
