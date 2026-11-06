// Settings last one visit: only the Quick Launch tile order (ORDER_KEY) is kept in localStorage.
// Keys older versions saved are removed on load so they stop applying.
import { THEME_KEY } from './themes.js';
import { MUTES_KEY } from './events-model.js';

export const STALE_KEYS = [THEME_KEY, 'dash.events.filters', MUTES_KEY];

export function clearStaleSettings(storage) {
  for (const k of STALE_KEYS) {
    try { storage?.removeItem(k); } catch { /* storage blocked: nothing was saved there either */ }
  }
}
