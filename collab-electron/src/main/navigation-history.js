const MAX_HISTORY = 100;

let history = [];
let currentIndex = -1;

/**
 * Record a tile focus event. Truncates forward history and caps size.
 */
export function pushToHistory(tileId) {
  // Deduplicate: if already at this tile, don't push again
  if (currentIndex >= 0 && history[currentIndex] === tileId) {
    return;
  }

  // Truncate forward history
  history = history.slice(0, currentIndex + 1);

  history.push(tileId);
  currentIndex = history.length - 1;

  // Cap size: remove oldest entries
  if (history.length > MAX_HISTORY) {
    const excess = history.length - MAX_HISTORY;
    history = history.slice(excess);
    currentIndex = Math.max(0, currentIndex - excess);
  }
}

/**
 * Navigate back in history. Returns the target tileId, or null if at boundary.
 */
export function goBack() {
  if (currentIndex <= 0) {
    return null;
  }
  currentIndex--;
  return history[currentIndex];
}

/**
 * Navigate forward in history. Returns the target tileId, or null if at boundary.
 */
export function goForward() {
  if (currentIndex < 0 || currentIndex >= history.length - 1) {
    return null;
  }
  currentIndex++;
  return history[currentIndex];
}

/**
 * Reset history state (useful for tests or app restart).
 */
export function resetHistory() {
  history = [];
  currentIndex = -1;
}
