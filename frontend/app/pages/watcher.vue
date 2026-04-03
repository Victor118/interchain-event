<template>
  <div class="watcher">
    <div class="watcher-header">
      <h2>Subscriptions Watcher</h2>
      <p class="watcher-subtitle">List subscriptions, check conditions, and submit proofs.</p>
    </div>
    <div class="watcher-placeholder">
      Coming next...
    </div>
  </div>
</template>

<style scoped>
.watcher {
  padding: 24px;
  height: 100%;
}

.watcher-header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.watcher-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.watcher-subtitle {
  color: var(--text-muted);
  font-size: 13px;
  margin-top: 4px;
}

.watcher-placeholder {
  color: var(--text-muted);
  text-align: center;
  margin-top: 80px;
  font-size: 14px;
}
</style>
