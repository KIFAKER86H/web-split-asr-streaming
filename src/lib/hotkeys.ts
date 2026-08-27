/**
 * The one hotkey the settings panel lets the operator rebind: swapping
 * transcribe + translate over to the alternate API slot (see `ApiSlot` in
 * `src/lib/server/config.ts`). `F2` (settings) and `F4` (start/stop) stay
 * fixed — they are wired directly into `CaptionStage` — because only the
 * swap key was ever asked to move.
 *
 * Stored in `localStorage`, the same as the display overrides in
 * `src/lib/display.ts`: a keybinding describes the room this screen is
 * running in, not any one tab, so every tab on this origin should agree on
 * it. Unlike those overrides it never has to reach the DOM before paint —
 * nothing about it is visible until a key is actually pressed — so there is
 * no bootstrap-script counterpart here.
 */

const STORAGE_KEY = "nectec.caption.hotkeys.v1";

export const DEFAULT_SWAP_SLOT_KEY = "F3";

function isUsableKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32;
}

export function readSwapSlotKey(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SWAP_SLOT_KEY;
    }
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).swapSlot
        : undefined;
    return isUsableKey(value) ? value : DEFAULT_SWAP_SLOT_KEY;
  } catch {
    // Private mode, a full quota, or hand-edited rubbish — the default key
    // is a perfectly good place to land.
    return DEFAULT_SWAP_SLOT_KEY;
  }
}

export function writeSwapSlotKey(key: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ swapSlot: key }));
  } catch {
    // Saving is a convenience; the binding is already active either way.
  }
}
