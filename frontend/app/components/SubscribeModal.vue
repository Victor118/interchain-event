<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="$emit('close')">
      <div class="modal">
        <div class="modal-header">
          <h3>Create Subscription</h3>
          <button class="modal-close" @click="$emit('close')">&times;</button>
        </div>

        <div class="modal-body">
          <!-- Path info -->
          <div class="field">
            <label>Navigation path</label>
            <div class="field-value path-display">
              {{ displayPath.join(' / ') }}
            </div>
          </div>

          <!-- Real Merkle path -->
          <div class="field">
            <label>Merkle path (for subscription)</label>
            <div class="field-value">
              <span class="merkle-store">store: {{ storeName }}</span>
              <span v-if="storeKey" class="merkle-key">key: 0x{{ storeKey }}</span>
              <span v-else class="merkle-key merkle-key--missing">key: will be determined by watcher</span>
            </div>
          </div>

          <!-- Current value (when available) -->
          <div v-if="currentValue !== null" class="field">
            <label>Current value</label>
            <div class="field-value value-display">{{ truncate(currentValue, 120) }}</div>
          </div>

          <!-- Condition -->
          <div v-if="isExistsOnly" class="field">
            <label>Condition</label>
            <div class="field-value">Exists</div>
          </div>

          <div v-else class="field">
            <label>Condition</label>
            <div class="condition-picker">
              <button
                v-for="c in leafConditions"
                :key="c"
                class="condition-btn"
                :class="{ 'condition-btn--active': condition === c }"
                @click="condition = c"
              >
                {{ c }}
              </button>
            </div>
          </div>

          <!-- Threshold (GreaterThan / LessThan) -->
          <div v-if="condition === 'GreaterThan' || condition === 'LessThan'" class="field">
            <label>Threshold</label>
            <input
              v-model="threshold"
              class="input"
              placeholder="Numeric threshold value"
            />
            <div class="field-hint">
              Encoding:
              <select v-model="encoding" class="select-inline">
                <option value="Numeric">Numeric</option>
                <option value="String">String</option>
                <option value="Bytes">Bytes</option>
              </select>
            </div>
          </div>

          <!-- Expected value (Equals) -->
          <div v-if="condition === 'Equals'" class="field">
            <label>Expected value</label>
            <input
              v-model="expectedValue"
              class="input"
              :placeholder="currentValue ?? ''"
            />
            <div class="field-hint">Pre-filled with current value. Edit if needed.</div>
          </div>

          <!-- Callback contract -->
          <div class="field">
            <label>Callback contract</label>
            <input
              v-model="callbackContract"
              class="input"
              placeholder="neutron1..."
            />
          </div>

          <!-- Callback message -->
          <div class="field">
            <label>Callback message (JSON)</label>
            <textarea
              v-model="callbackMsg"
              class="input textarea"
              placeholder='{"on_proof_verified":{}}'
            />
          </div>

          <!-- Client ID -->
          <div class="field">
            <label>IBC Client ID</label>
            <input
              v-model="clientId"
              class="input"
              placeholder="07-tendermint-..."
            />
          </div>

          <!-- Expiry -->
          <div class="field">
            <label>Expires after (blocks, optional)</label>
            <input
              v-model="expiresAfter"
              class="input"
              type="number"
              placeholder="e.g. 100000"
            />
          </div>
        </div>

        <div class="modal-footer">
          <div class="modal-preview">
            <button class="preview-toggle" @click="showPreview = !showPreview">
              {{ showPreview ? 'Hide' : 'Show' }} JSON preview
            </button>
            <pre v-if="showPreview" class="preview-json">{{ jsonPreview }}</pre>
          </div>
          <div class="modal-actions">
            <button class="btn btn--secondary" @click="$emit('close')">Cancel</button>
            <button class="btn btn--primary" @click="copyJson">Copy JSON</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { StateNode } from '~/composables/useStateExplorer'

const props = defineProps<{
  node: StateNode
  preCondition?: string | null
  preValue?: string | null
  preSearchKey?: string | null
}>()

defineEmits<{
  close: []
}>()

const leafConditions = ['Equals', 'GreaterThan', 'LessThan'] as const
type LeafCondition = typeof leafConditions[number]

// Is this purely an Exists subscription?
const isExistsOnly = computed(() => props.preCondition === 'Exists')

// Determine the current value: from leaf node or from search result
const currentValue = computed(() => {
  if (props.preValue !== null && props.preValue !== undefined) return props.preValue
  if (props.node.value !== null) return props.node.value
  return null
})

// Real Merkle store name (e.g. "wasm", "bank")
const storeName = computed(() => props.node.storeName ?? props.node.module)

// Real IAVL key hex (if available)
const storeKey = computed(() => props.node.storeKey ?? null)

// Display path (UI only)
const displayPath = computed(() => {
  const base = [...props.node.path]
  if (props.preSearchKey) base.push(props.preSearchKey)
  return base
})

const condition = ref<LeafCondition>(
  (props.preCondition && props.preCondition !== 'Exists')
    ? props.preCondition as LeafCondition
    : 'Equals'
)
const threshold = ref('')
const encoding = ref('Numeric')
const expectedValue = ref(currentValue.value ?? '')
const callbackContract = ref('')
const callbackMsg = ref('{"on_proof_verified":{}}')
const clientId = ref('')
const expiresAfter = ref('')
const showPreview = ref(false)

const jsonPreview = computed(() => {
  const msg: any = {
    subscribe: {
      client_id: clientId.value || '<client_id>',
      key_path: [storeName.value],
      condition: buildCondition(),
      callback_contract: callbackContract.value || '<callback_contract>',
      callback_msg: callbackMsg.value || '{}',
    },
  }

  if (storeKey.value) {
    msg.subscribe._store_key_hex = storeKey.value
  }

  if (expiresAfter.value) {
    msg.subscribe.expires_after_blocks = parseInt(expiresAfter.value)
  }

  return JSON.stringify(msg, null, 2)
})

function buildCondition() {
  if (isExistsOnly.value) {
    return 'exists'
  }
  if (condition.value === 'Equals') {
    return { equals: { expected: expectedValue.value } }
  }
  if (condition.value === 'GreaterThan') {
    return { greater_than: { threshold: threshold.value, encoding: encoding.value.toLowerCase() } }
  }
  if (condition.value === 'LessThan') {
    return { less_than: { threshold: threshold.value, encoding: encoding.value.toLowerCase() } }
  }
}

function copyJson() {
  navigator.clipboard.writeText(jsonPreview.value)
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 520px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-header h3 {
  font-size: 15px;
  font-weight: 600;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
}

.modal-close:hover {
  color: var(--text);
}

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}

.field {
  margin-bottom: 14px;
}

.field label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.field-value {
  font-size: 13px;
  color: var(--text);
}

.path-display {
  color: var(--accent);
  font-size: 12px;
}

.value-display {
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}

.merkle-store {
  color: var(--accent);
  font-size: 12px;
  margin-right: 12px;
}

.merkle-key {
  color: var(--text-muted);
  font-size: 11px;
  word-break: break-all;
}

.merkle-key--missing {
  font-style: italic;
}

.condition-picker {
  display: flex;
  gap: 4px;
}

.condition-btn {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.condition-btn:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

.condition-btn--active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s;
}

.input:focus {
  border-color: var(--accent);
}

.textarea {
  min-height: 60px;
  resize: vertical;
}

.field-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.select-inline {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font-family: inherit;
  font-size: 11px;
  padding: 1px 4px;
  margin-left: 4px;
  outline: none;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}

.modal-preview {
  margin-bottom: 12px;
}

.preview-toggle {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.preview-toggle:hover {
  color: var(--text);
}

.preview-json {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 11px;
  color: var(--accent);
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
  font-family: inherit;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn--secondary {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.btn--secondary:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

.btn--primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.btn--primary:hover {
  opacity: 0.9;
}
</style>
