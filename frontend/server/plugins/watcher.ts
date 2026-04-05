import { startWatcher } from "../utils/watcher";

export default defineNitroPlugin(() => {
  // Start the watcher with 30s poll interval
  startWatcher(30_000);
});
