<template>
  <div class="tree-node">
    <!-- Load more placeholder -->
    <div
      v-if="node.isLoadMore"
      class="tree-row tree-row--load-more"
      :style="{ paddingLeft: depth * 20 + 8 + 'px' }"
      @click="$emit('loadMore')"
    >
      <span class="tree-icon">
        <span v-if="node.loading" class="spinner" />
        <span v-else>+</span>
      </span>
      <span class="load-more-label">{{ node.loading ? 'Loading...' : 'Load more...' }}</span>
    </div>

    <!-- Normal node -->
    <template v-else>
      <div
        class="tree-row"
        :style="{ paddingLeft: depth * 20 + 8 + 'px' }"
        @click="onRowClick"
      >
        <!-- Expand/collapse icon -->
        <span v-if="node.hasChildren || node.value !== null" class="tree-icon">
          <span v-if="node.loading" class="spinner" />
          <span v-else class="chevron" :class="{ 'chevron--open': node.expanded }">&#9654;</span>
        </span>
        <span v-else class="tree-icon tree-icon--leaf">&#9679;</span>

        <!-- Node label -->
        <span class="tree-key" :class="{ 'tree-key--module': depth === 0 }">{{ node.key }}</span>

        <!-- Watch button (leaf) -->
        <button
          v-if="canWatchLeaf"
          class="watch-btn"
          title="Create subscription"
          @click.stop="openSubscribe"
        >
          &#x1F441;
        </button>
      </div>

      <!-- Search bar for searchable folders -->
      <div
        v-if="node.searchable && node.expanded"
        class="search-bar"
        :style="{ paddingLeft: (depth + 1) * 20 + 8 + 'px' }"
      >
        <div class="search-row">
          <input
            v-model="searchInput"
            class="search-input"
            :placeholder="node.searchPlaceholder ?? 'Search a key...'"
            @keyup.enter="onSearch"
          />
          <button class="search-go" @click="onSearch" :disabled="!searchInput || searching">
            <span v-if="searching" class="spinner" />
            <span v-else>&#x1F50D;</span>
          </button>
        </div>
        <!-- Search result -->
        <div v-if="searchResult !== null" class="search-result">
          <div v-if="searchResult.found" class="search-found">
            <div class="search-found-header">
              <span class="search-found-label">{{ searchInput }}</span>
              <span class="search-found-info">{{ searchResult.value }}</span>
            </div>
            <!-- Inline children from search (e.g. balances, contract state) -->
            <div v-if="searchResult.children && searchResult.children.length > 0" class="search-children">
              <div
                v-for="child in displayedSearchChildren"
                :key="child.key"
                class="search-child-row"
              >
                <span class="search-child-key">{{ child.key }}</span>
                <button
                  class="watch-btn watch-btn--inline"
                  title="Create subscription"
                  @click="openSubscribeForChild(child)"
                >
                  &#x1F441;
                </button>
                <span class="search-child-value">{{ truncate(child.value ?? '', 50) }}</span>
              </div>
              <button
                v-if="searchResult.children.length > displayedSearchCount"
                class="load-more-btn"
                @click="displayedSearchCount += PAGE_SIZE"
              >
                Load more... ({{ searchResult.children.length - displayedSearchCount }} remaining)
              </button>
            </div>
            <!-- No children but value found → direct subscribe -->
            <div v-else class="search-found-actions">
              <span class="search-hint">Condition:</span>
              <button
                v-for="c in ['Equals', 'GreaterThan', 'LessThan']"
                :key="c"
                class="condition-mini-btn"
                @click="openSubscribeWithCondition(c, searchResult.value)"
              >{{ c }}</button>
            </div>
          </div>
          <div v-else class="search-not-found">
            <span>Not found.</span>
            <button class="condition-mini-btn" @click="openSubscribeExists">Watch with Exists</button>
          </div>
        </div>
      </div>

      <!-- Search bar for non-searchable folders (generic key search) -->
      <div
        v-if="canWatchFolder && !node.searchable && node.expanded"
        class="search-bar"
        :style="{ paddingLeft: (depth + 1) * 20 + 8 + 'px' }"
      >
        <div class="search-row">
          <input
            v-model="searchInput"
            class="search-input"
            placeholder="Search or watch a key..."
            @keyup.enter="onSearch"
          />
          <button class="search-go" @click="onSearch" :disabled="!searchInput || searching">
            <span v-if="searching" class="spinner" />
            <span v-else>&#x1F441;</span>
          </button>
        </div>
        <div v-if="searchResult !== null" class="search-result">
          <div v-if="searchResult.found" class="search-found">
            <span class="search-found-label">Key exists — value:</span>
            <pre class="search-found-value">{{ searchResult.value }}</pre>
            <div class="search-found-actions">
              <span class="search-hint">Condition:</span>
              <button
                v-for="c in ['Equals', 'GreaterThan', 'LessThan']"
                :key="c"
                class="condition-mini-btn"
                @click="openSubscribeWithCondition(c, searchResult.value)"
              >{{ c }}</button>
            </div>
          </div>
          <div v-else class="search-not-found">
            <span>Key not found.</span>
            <button class="condition-mini-btn" @click="openSubscribeExists">Watch with Exists</button>
          </div>
        </div>
      </div>

      <!-- Expanded value for leaves -->
      <div
        v-if="!node.hasChildren && node.value !== null && node.expanded"
        class="tree-value-detail"
        :style="{ paddingLeft: (depth + 1) * 20 + 8 + 'px' }"
      >
        <pre class="value-content">{{ formatValue(node.value) }}</pre>
      </div>

      <!-- Children -->
      <div v-if="node.expanded && node.children.length > 0">
        <TreeNode
          v-for="child in node.children"
          :key="child.key"
          :node="child"
          :depth="depth + 1"
          :rest="rest"
          @load-more="onLoadMore"
        />
      </div>

      <!-- Empty state -->
      <div
        v-if="node.expanded && !node.loading && node.children.length === 0 && node.hasChildren && !node.searchable"
        class="tree-empty"
        :style="{ paddingLeft: (depth + 1) * 20 + 8 + 'px' }"
      >
        (empty)
      </div>

      <!-- Subscribe modal -->
      <SubscribeModal
        v-if="showModal"
        :node="modalNode ?? node"
        :pre-condition="modalCondition"
        :pre-value="modalValue"
        :pre-search-key="modalSearchKey"
        @close="showModal = false"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import type { StateNode } from '~/composables/useStateExplorer'

const PAGE_SIZE = 30

const props = defineProps<{
  node: StateNode
  depth: number
  rest: string
}>()

const emit = defineEmits<{
  loadMore: []
}>()

const { toggleNode, loadMore, searchKey } = useStateExplorer()

const showModal = ref(false)
const modalCondition = ref<string | null>(null)
const modalValue = ref<string | null>(null)
const modalSearchKey = ref<string | null>(null)
const modalNode = ref<StateNode | null>(null)

const searchInput = ref('')
const searching = ref(false)
const searchResult = ref<{ found: boolean; value: string | null; children?: StateNode[] } | null>(null)
const displayedSearchCount = ref(PAGE_SIZE)

const canWatchLeaf = computed(() => !props.node.hasChildren && props.node.value !== null)
const canWatchFolder = computed(() => props.node.hasChildren && props.depth > 0)

const displayedSearchChildren = computed(() => {
  if (!searchResult.value?.children) return []
  return searchResult.value.children.slice(0, displayedSearchCount.value)
})

function onRowClick() {
  if (props.node.hasChildren) {
    toggleNode(props.node, props.rest)
  } else if (props.node.value !== null) {
    props.node.expanded = !props.node.expanded
  }
}

function onLoadMore() {
  loadMore(props.node, props.rest)
}

async function onSearch() {
  if (!searchInput.value) return
  searching.value = true
  searchResult.value = null
  displayedSearchCount.value = PAGE_SIZE

  try {
    searchResult.value = await searchKey(props.node, props.rest, searchInput.value)
  } finally {
    searching.value = false
  }
}

// Leaf subscribe
function openSubscribe() {
  modalNode.value = null
  modalCondition.value = null
  modalValue.value = null
  modalSearchKey.value = null
  showModal.value = true
}

// Subscribe for a child found via search
function openSubscribeForChild(child: StateNode) {
  modalNode.value = child
  modalCondition.value = null
  modalValue.value = child.value
  modalSearchKey.value = null
  showModal.value = true
}

// Subscribe with a specific condition from search result
function openSubscribeWithCondition(condition: string, value: string | null) {
  modalNode.value = null
  modalCondition.value = condition
  modalValue.value = value
  modalSearchKey.value = searchInput.value
  showModal.value = true
}

// Subscribe with Exists (key not found)
function openSubscribeExists() {
  modalNode.value = null
  modalCondition.value = 'Exists'
  modalValue.value = null
  modalSearchKey.value = searchInput.value
  showModal.value = true
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}

function formatValue(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
</script>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s;
  min-height: 28px;
}

.tree-row:hover {
  background: var(--bg-hover);
}

.tree-row--load-more {
  cursor: pointer;
}

.load-more-label {
  color: var(--accent);
  font-size: 12px;
}

.tree-icon {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}

.tree-icon--leaf {
  font-size: 6px;
}

.chevron {
  display: inline-block;
  transition: transform 0.15s;
}

.chevron--open {
  transform: rotate(90deg);
}

.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.tree-key {
  color: var(--text);
  white-space: nowrap;
}

.tree-key--module {
  color: var(--accent);
  font-weight: 600;
}

.watch-btn {
  margin-left: 4px;
  background: none;
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s, border-color 0.15s, color 0.15s;
  font-size: 14px;
  flex-shrink: 0;
}

.watch-btn--inline {
  font-size: 12px;
  padding: 1px 4px;
}

.tree-row:hover .watch-btn,
.watch-btn:hover {
  opacity: 1;
  color: var(--accent);
  border-color: var(--accent);
}

/* Search bar */
.search-bar {
  padding: 4px 8px 8px;
}

.search-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.search-input {
  flex: 1;
  padding: 4px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.search-go {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
  color: var(--text);
  font-size: 13px;
  transition: all 0.15s;
}

.search-go:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.search-go:disabled {
  opacity: 0.4;
  cursor: default;
}

.search-result {
  margin-top: 6px;
  font-size: 12px;
}

.search-found {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
}

.search-found-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.search-found-label {
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.search-found-info {
  color: var(--text-muted);
  font-size: 11px;
}

.search-found-value {
  margin: 4px 0 8px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
  font-size: 12px;
}

.search-children {
  margin-top: 4px;
}

.search-child-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
}

.search-child-row:last-child {
  border-bottom: none;
}

.search-child-key {
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
}

.search-child-value {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.load-more-btn {
  background: none;
  border: none;
  color: var(--accent);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 0;
}

.load-more-btn:hover {
  text-decoration: underline;
}

.search-found-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}

.search-hint {
  color: var(--text-muted);
  font-size: 11px;
}

.condition-mini-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: none;
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.condition-mini-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.search-not-found {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  padding: 4px 0;
}

/* Value detail */
.tree-value-detail {
  padding: 4px 8px;
}

.value-content {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--accent);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 2px 0;
  font-family: inherit;
}

.tree-empty {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
  padding: 4px 8px;
}
</style>
