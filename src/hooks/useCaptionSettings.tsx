"use client";

import { createContext, useContext, type ReactNode } from "react";

import {
  DEFAULT_CAPTION_SETTINGS,
  type CaptionSettings,
} from "@/lib/caption";

/**
 * Caption settings for the current run.
 *
 * They come from a server component, which reads `.env` and renders the values
 * into the first HTML the browser receives. That keeps the read synchronous —
 * a fetch after mount would resolve past first paint and the text would visibly
 * reflow.
 *
 * A context rather than a prop chain: `CaptionPane` needs the typography two
 * levels down, and threading it through would put a server concern in the
 * signature of every component in between.
 */
const CaptionSettingsContext = createContext<CaptionSettings>(
  DEFAULT_CAPTION_SETTINGS,
);

interface CaptionSettingsProviderProps {
  settings: CaptionSettings;
  children: ReactNode;
}

export function CaptionSettingsProvider({
  settings,
  children,
}: CaptionSettingsProviderProps) {
  return (
    <CaptionSettingsContext.Provider value={settings}>
      {children}
    </CaptionSettingsContext.Provider>
  );
}

export function useCaptionSettings(): CaptionSettings {
  return useContext(CaptionSettingsContext);
}
