"use client";

import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_SWAP_SLOT_KEY,
  readSwapSlotKey,
  subscribeSwapSlotKey,
  writeSwapSlotKey,
} from "@/lib/hotkeys";

export interface UseSwapSlotKeyResult {
  swapSlotKey: string;
  setSwapSlotKey: (key: string) => void;
}

/**
 * The operator's chosen key for "swap API slot", as React state.
 *
 * Starts at the hard-coded default during server rendering — `localStorage`
 * does not exist there — and swaps to the saved binding in an effect right
 * after mount, the same pattern `useTabMode` uses and for the same reason:
 * nothing renders differently based on this value (it only wires up a
 * `keydown` listener), so there is no hydration mismatch to avoid, but the
 * read itself still has to wait for a browser to exist.
 */
export function useSwapSlotKey(): UseSwapSlotKeyResult {
  const [swapSlotKey, setKeyState] = useState(DEFAULT_SWAP_SLOT_KEY);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKeyState(readSwapSlotKey());

    // The binding describes the room, not the tab (see `src/lib/hotkeys.ts`),
    // so a rebind made in one tab's settings panel has to reach the others
    // straight away — every one of them is listening for that same key press,
    // and a tab still watching for the old one would silently ignore it.
    return subscribeSwapSlotKey(() => setKeyState(readSwapSlotKey()));
  }, []);

  const setSwapSlotKey = useCallback((next: string) => {
    setKeyState(next);
    writeSwapSlotKey(next);
  }, []);

  return { swapSlotKey, setSwapSlotKey };
}
