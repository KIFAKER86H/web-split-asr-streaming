"use client";

import { useCallback, useEffect, useState } from "react";

import { initialTabMode, saveTabMode, type TabMode } from "@/lib/tab-mode";

export interface UseTabModeResult {
  mode: TabMode;
  setMode: (mode: TabMode) => void;
}

/**
 * Which pane this tab shows, as React state.
 *
 * Starts at `"transcribe"` during server rendering — `sessionStorage` and the
 * URL's query string do not exist there — and swaps to the tab's real choice
 * in an effect right after mount. That one swap can visibly change which pane
 * is on screen, unlike the display overrides in `useCaptionSettings`, which is
 * why it happens in an effect rather than a lazy `useState` initialiser: the
 * initialiser runs during the first client render too, before hydration has
 * reconciled against the server markup, and reading a different value there
 * than the server used is exactly the mismatch React's hydration warns about.
 * A one-tab-mode flash on load is a fair trade for that.
 */
export function useTabMode(): UseTabModeResult {
  const [mode, setModeState] = useState<TabMode>("transcribe");

  useEffect(() => {
    // See the doc comment above: this has to run post-mount so the first
    // client render matches the server's, which is exactly the "detect a
    // client-only external value" case an effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(initialTabMode());
  }, []);

  const setMode = useCallback((next: TabMode) => {
    setModeState(next);
    saveTabMode(next);
  }, []);

  return { mode, setMode };
}
