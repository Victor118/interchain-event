<template>
  <div class="watcher">
    <div class="watcher-header">
      <h2>Watcher Dashboard</h2>
      <div class="watcher-status">
        <span class="status-dot" :class="{ 'status-dot--active': status?.running }" />
        <span>{{ status?.running ? 'Running' : 'Stopped' }}</span>
        <span v-if="status?.lastCheck" class="status-time">
          Last check: {{ formatTime(status.lastCheck) }}
        </span>
      </div>
    </div>

    <div v-if="status?.error" class="watcher-error">{{ status.error }}</div>

    <!-- Active subscriptions -->
    <div class="section">
      <h3>Active Subscriptions ({{ status?.subscriptions?.length ?? 0 }})</h3>
      <div v-if="!status?.subscriptions?.length" class="empty">No active subscriptions</div>
      <div v-for="sub in status?.subscriptions" :key="sub.id" class="sub-card">
        <div class="sub-header">
          <span class="sub-id">#{{ sub.id }}</span>
          <span class="sub-condition">{{ formatCondition(sub.condition) }}</span>
          <span class="sub-client">{{ sub.client_id }}</span>
        </div>
        <div class="sub-details">
          <div><span class="label">Creator:</span> {{ truncate(sub.creator, 20) }}</div>
          <div><span class="label">Key path:</span> {{ sub.key_path.join(' / ') }}</div>
          <div><span class="label">Callback:</span> {{ truncate(sub.callback_contract, 20) }}</div>
          <div><span class="label">Created at block:</span> {{ sub.created_at }}</div>
        </div>
        <div class="sub-actions">
          <input
            v-model="proofKeys[sub.id]"
            class="input"
            placeholder="IAVL key (hex) to prove"
          />
          <button
            class="btn btn--primary"
            :disabled="submitting[sub.id] || !proofKeys[sub.id]"
            @click="submitProof(sub.id)"
          >
            {{ submitting[sub.id] ? 'Submitting...' : 'Submit Proof' }}
          </button>
        </div>
        <div v-if="proofResults[sub.id]" class="sub-result">
          TX: {{ proofResults[sub.id] }}
        </div>
        <div v-if="proofErrors[sub.id]" class="sub-error">
          {{ proofErrors[sub.id] }}
        </div>
      </div>
    </div>

    <!-- Event log -->
    <div class="section">
      <h3>Event Log</h3>
      <div v-if="!status?.events?.length" class="empty">No events yet</div>
      <div class="event-log">
        <div
          v-for="(event, i) in status?.events"
          :key="i"
          class="event-row"
          :class="'event-row--' + event.type"
        >
          <span class="event-time">{{ formatTime(event.timestamp) }}</span>
          <span class="event-type">{{ event.type }}</span>
          <span v-if="event.subscription_id" class="event-sub">#{{ event.subscription_id }}</span>
          <span class="event-msg">{{ event.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const status = ref<any>(null)
const proofKeys = ref<Record<number, string>>({})
const submitting = ref<Record<number, boolean>>({})
const proofResults = ref<Record<number, string>>({})
const proofErrors = ref<Record<number, string>>({})

async function fetchStatus() {
  try {
    status.value = await $fetch('/api/watcher/status')
  } catch (e: any) {
    console.error('Failed to fetch watcher status:', e.message)
  }
}

async function submitProof(subscriptionId: number) {
  submitting.value[subscriptionId] = true
  proofResults.value[subscriptionId] = ''
  proofErrors.value[subscriptionId] = ''

  try {
    const result = await $fetch('/api/watcher/submit-proof', {
      method: 'POST',
      body: {
        subscription_id: subscriptionId,
        iavl_key_hex: proofKeys.value[subscriptionId],
      },
    })
    proofResults.value[subscriptionId] = (result as any).txHash
    // Refresh status to see the new event
    await fetchStatus()
  } catch (e: any) {
    proofErrors.value[subscriptionId] = e.data?.message || e.message || 'Failed'
  } finally {
    submitting.value[subscriptionId] = false
  }
}

function formatCondition(condition: any): string {
  if (condition === 'exists') return 'Exists'
  if (condition.json_path_equals) return `${condition.json_path_equals.path} = "${condition.json_path_equals.expected}"`
  if (condition.equals) return 'Equals'
  if (condition.greater_than) return 'GreaterThan'
  if (condition.less_than) return 'LessThan'
  return JSON.stringify(condition)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

// Poll status every 5s
let interval: ReturnType<typeof setInterval>
onMounted(() => {
  fetchStatus()
  interval = setInterval(fetchStatus, 5000)
})
onUnmounted(() => clearInterval(interval))
</script>

<style scoped>
.watcher {
  padding: 24px;
  height: 100%;
  overflow-y: auto;
}

.watcher-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.watcher-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.watcher-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
}

.status-dot--active {
  background: #50c878;
  box-shadow: 0 0 6px rgba(80, 200, 120, 0.5);
}

.status-time {
  color: var(--text-muted);
}

.watcher-error {
  padding: 8px 12px;
  background: rgba(220, 180, 50, 0.1);
  border: 1px solid rgba(220, 180, 50, 0.3);
  border-radius: 6px;
  color: #dcb432;
  font-size: 12px;
  margin-bottom: 16px;
}

.section {
  margin-bottom: 24px;
}

.section h3 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.empty {
  color: var(--text-muted);
  font-size: 13px;
  font-style: italic;
}

.sub-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 8px;
}

.sub-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.sub-id {
  font-weight: 600;
  color: var(--accent);
}

.sub-condition {
  font-size: 12px;
  padding: 2px 8px;
  background: var(--accent-dim);
  border-radius: 3px;
  color: var(--accent);
}

.sub-client {
  font-size: 11px;
  color: var(--text-muted);
}

.sub-details {
  font-size: 12px;
  color: var(--text-muted);
  display: grid;
  gap: 2px;
  margin-bottom: 10px;
}

.label {
  color: var(--text);
  font-weight: 500;
}

.sub-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.input {
  flex: 1;
  padding: 5px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.input:focus {
  border-color: var(--accent);
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.btn--primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: var(--bg);
  font-weight: 600;
}

.btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sub-result {
  margin-top: 8px;
  font-size: 11px;
  color: #50c878;
  word-break: break-all;
}

.sub-error {
  margin-top: 8px;
  font-size: 11px;
  color: #dc5050;
  word-break: break-word;
}

.event-log {
  max-height: 400px;
  overflow-y: auto;
}

.event-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.event-time {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.event-type {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  flex-shrink: 0;
}

.event-row--check .event-type {
  background: rgba(100, 100, 200, 0.15);
  color: #8888cc;
}

.event-row--condition_met .event-type {
  background: rgba(80, 200, 120, 0.15);
  color: #50c878;
}

.event-row--proof_submitted .event-type {
  background: rgba(80, 200, 120, 0.15);
  color: #50c878;
}

.event-row--error .event-type {
  background: rgba(220, 80, 80, 0.15);
  color: #dc5050;
}

.event-sub {
  color: var(--accent);
  font-weight: 500;
  flex-shrink: 0;
}

.event-msg {
  color: var(--text);
  word-break: break-word;
}
</style>
