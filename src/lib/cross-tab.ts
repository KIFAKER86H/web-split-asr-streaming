/**
 * The one piece of plumbing behind "change it here, it changes over there".
 *
 * Some settings in this app describe the *screen* rather than the tab — the
 * font the caption is drawn in, how big it is, which key swaps the API slot.
 * Two tabs open on the same origin should agree on those, and they already
 * did in the sense that both read the same `localStorage` entry on load; what
 * they did not do was notice a change made after that load, so adjusting the
 * font on the transcribe tab left the translate tab on a projector next door
 * showing the old one until somebody refreshed it.
 *
 * `storage` is the browser's own answer to that, and the reason it lives in a
 * file of its own rather than being written twice is the two edges below:
 * both are easy to miss, and getting either wrong is the kind of bug that only
 * shows up on someone else's second monitor.
 *
 * Settings that are deliberately *not* shared — which pane a tab shows, which
 * microphone it would use — are kept in `sessionStorage` or in plain React
 * state precisely so that nothing here can reach them. See
 * `src/lib/tab-mode.ts` for that side of the split.
 */

/**
 * Calls `onChange` whenever another tab on this origin changes `key` in
 * `localStorage`. Returns the unsubscribe.
 *
 * The event fires only in the *other* tabs, never in the one that did the
 * writing, so a writer never hears its own change echoed back and no
 * loop-breaking guard is needed at the call site.
 *
 * `onChange` takes no arguments on purpose: callers re-read through their own
 * validating reader (`readOverrides`, `readSwapSlotKey`) rather than trusting
 * `event.newValue`, which arrives as a raw string from another tab and has to
 * be parsed and range-checked anyway.
 */
export function subscribeStorageKey(key: string, onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    // `sessionStorage` fires this event too, and everything kept there is
    // per-tab by definition — the exact opposite of a shared setting.
    if (event.storageArea && event.storageArea !== window.localStorage) {
      return;
    }
    // A `null` key means the whole store was cleared rather than one entry
    // written, which took this key with it — the event carries no name to
    // match against, so it has to be treated as "assume ours changed".
    if (event.key !== null && event.key !== key) {
      return;
    }
    onChange();
  };

  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
