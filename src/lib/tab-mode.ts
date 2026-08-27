/**
 * Which pane this browser tab shows — the one setting that is deliberately
 * *not* shared with every other tab.
 *
 * Font, size and the rest of `src/lib/display.ts` live in `localStorage`
 * because they describe the screen a tab is running on, and two tabs open on
 * the same screen should look the same. Mode is different: the whole point of
 * splitting transcribe and translate into separate tabs is that each one can
 * be sent to its own OBS browser source or its own monitor while pointed at
 * the same URL, so it has to stay put on its own tab even though every tab is
 * the same page loaded from the same origin. `sessionStorage` is exactly the
 * browser's tool for that — a fresh copy per tab, never shared, and it
 * survives a reload of that tab (unlike a variable in memory) but does not
 * follow a duplicated tab into a copy of its own.
 */

export type TabMode = "transcribe" | "translate";

const STORAGE_KEY = "nectec.caption.mode.v1";

function isTabMode(value: unknown): value is TabMode {
  return value === "transcribe" || value === "translate";
}

/**
 * The mode a freshly opened tab should start in.
 *
 * `?mode=` on the URL wins first — the point of a query string is that it
 * survives a link, a bookmark, or an OBS browser-source URL pasted somewhere,
 * which `sessionStorage` cannot do since it is not part of the address. Absent
 * that, the tab's own remembered choice from a previous load in the same tab
 * wins. `transcribe` is the fallback for a bare URL with neither, since it is
 * the side someone probably wants to see first.
 */
export function initialTabMode(): TabMode {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("mode");
    if (isTabMode(fromQuery)) {
      return fromQuery;
    }
  } catch {
    // Malformed query string — fall through to the stored value.
  }

  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (isTabMode(stored)) {
      return stored;
    }
  } catch {
    // Private mode or a full quota — the default below is a fine landing spot.
  }

  return "transcribe";
}

/** Remembers the choice for the next reload of *this* tab only. */
export function saveTabMode(mode: TabMode): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Saving is a convenience; the mode is already applied on screen either way.
  }
}
