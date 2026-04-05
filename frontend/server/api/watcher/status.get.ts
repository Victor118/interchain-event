import { getWatcherState } from "../../utils/watcher";

export default defineEventHandler(() => {
  return getWatcherState();
});
