/**
 * Which microphone the operator picked.
 *
 * Shared across every tab on this origin, and stored, for the same reason the
 * display overrides in `src/lib/display.ts` are: it describes the room the
 * screens are standing in — one machine, one microphone on the lectern — not
 * anything about a particular tab. Setting it on the transcribe tab and then
 * starting the recording from the translate tab is a perfectly ordinary way to
 * work, and before this the second tab would quietly have recorded from
 * whatever the browser listed first instead.
 *
 * Sharing an id across tabs is only meaningful because `deviceId` is stable
 * for a given origin and browser profile: every tab here is the same profile
 * on the same machine, so the same string names the same hardware in all of
 * them. (It is deliberately *not* stable across profiles or machines, and it
 * is rotated when site permissions are cleared — which is why the resolved
 * choice always falls back to the first listed device when the stored id is
 * not among those actually present. See `useAudioDevices`.)
 *
 * Unlike the display overrides this never has to reach the DOM before paint —
 * nothing about it is visible until a recording starts — so there is no
 * bootstrap-script counterpart, the same as `src/lib/hotkeys.ts`.
 */

import { subscribeStorageKey } from "@/lib/cross-tab";

const STORAGE_KEY = "nectec.caption.mic.v1";

/** No explicit choice — whatever the browser lists first stands. */
const NO_PREFERENCE = "";

/**
 * Ids are opaque strings the browser hands out (a hash, or one of the
 * `default` / `communications` aliases Chrome uses). Nothing here parses one,
 * so the only real check is that it is a non-empty string of a sane length —
 * enough to keep hand-edited rubbish from reaching `getUserMedia`.
 */
function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function readPreferredDevice(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return NO_PREFERENCE;
    }
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).deviceId
        : undefined;
    return isUsableId(value) ? value : NO_PREFERENCE;
  } catch {
    // Private mode, a full quota, or hand-edited rubbish — falling back to the
    // browser's own first device is a perfectly good place to land.
    return NO_PREFERENCE;
  }
}

function writePreferredDevice(deviceId: string): void {
  try {
    if (!isUsableId(deviceId)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceId }));
  } catch {
    // Saving is a convenience; the choice is already in force in this tab.
  }
}

// ── The preference as a subscribable store ───────────────────────────────

let cached: string | null = null;
const listeners = new Set<() => void>();
/** Live only while something is subscribed — see `subscribePreferredDevice`. */
let stopStorageSync: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Takes on the choice another tab just made — see `adoptStoredOverrides` in
 *  `src/lib/display.ts`, which this mirrors. */
function adoptStoredPreference(): void {
  const next = readPreferredDevice();
  if (next === cached) {
    return;
  }
  cached = next;
  notify();
}

export function subscribePreferredDevice(listener: () => void): () => void {
  if (listeners.size === 0) {
    stopStorageSync = subscribeStorageKey(STORAGE_KEY, adoptStoredPreference);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopStorageSync?.();
      stopStorageSync = null;
    }
  };
}

export function preferredDeviceSnapshot(): string {
  cached ??= readPreferredDevice();
  return cached;
}

/** `localStorage` does not exist while rendering on the server, and no markup
 *  depends on this anyway. */
export const serverPreferredDeviceSnapshot = (): string => NO_PREFERENCE;

/** Records the choice, stores it, and tells every subscriber — here and, via
 *  the `storage` event, in every other tab. */
export function setPreferredDevice(deviceId: string): void {
  if (deviceId === cached) {
    return;
  }
  cached = deviceId;
  writePreferredDevice(deviceId);
  notify();
}
