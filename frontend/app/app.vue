<template>
  <div class="app">
    <header class="app-header">
      <h1 class="app-title">Interchain Events</h1>
      <nav class="app-tabs">
        <NuxtLink to="/explorer" class="tab" active-class="tab--active">Explorer</NuxtLink>
        <NuxtLink to="/watcher" class="tab" active-class="tab--active">Watcher</NuxtLink>
      </nav>
    </header>
    <main class="app-main">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
:root {
  --bg: #0f1117;
  --bg-surface: #1a1d27;
  --bg-hover: #242736;
  --border: #2e3241;
  --text: #e1e4ed;
  --text-muted: #8b90a0;
  --accent: #00dc82;
  --accent-dim: #00dc8222;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
}

.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 20px;
  height: 48px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.app-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
}

.app-tabs {
  display: flex;
  gap: 4px;
}

.tab {
  padding: 6px 16px;
  border-radius: 6px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 13px;
  transition: all 0.15s;
}

.tab:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.tab--active {
  color: var(--accent);
  background: var(--accent-dim);
}

.app-main {
  flex: 1;
  overflow: hidden;
}
</style>
