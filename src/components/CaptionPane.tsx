"use client";

import type { ReactNode } from "react";

import { useDelayedAutoScroll } from "@/hooks/useDelayedAutoScroll";
import type { ScrollMotion } from "@/lib/caption";

interface CaptionPaneProps {
  /** Rendered as one flowing paragraph; empty shows `placeholder` instead. */
  text: string;
  /**
   * Unfinished text, continuing the same paragraph. Dimmed, because it will
   * still be rewritten — a reader should be able to tell at a glance which
   * words have settled. Only the transcribe tab ever passes this.
   */
  pending?: string;
  placeholder: ReactNode;
  scrollMotion: ScrollMotion;
  /** Accessible name for the pane. */
  label: string;
}

/**
 * The one caption surface a tab shows — full screen, one language.
 *
 * A display surface, not a document: `overflow-hidden` means the text can only
 * run forward under script control, and `select-none` keeps it from being
 * dragged over.
 */
export function CaptionPane({
  text,
  pending = "",
  placeholder,
  scrollMotion,
  label,
}: CaptionPaneProps) {
  const viewportRef = useDelayedAutoScroll<HTMLDivElement>({
    // Interim text counts: it is what pushes new lines onto the screen while
    // someone is mid-sentence, and the view has to follow those too.
    signal: `${text.length}:${pending.length}`,
    motion: scrollMotion,
  });

  return (
    <div
      ref={viewportRef}
      role="log"
      aria-live="polite"
      aria-label={label}
      // Side margins scale with the viewport so the text keeps the same visual
      // breathing room whether the display is a laptop or a hall projector.
      // Vertical padding belongs to `.caption-pane` in `globals.css`, which
      // collapses along with the pane.
      className="caption-pane caption-viewport min-h-0 flex-1 overflow-hidden px-[clamp(1.25rem,5vw,7rem)] select-none"
    >
      {text || pending ? (
        // A finished turn continues the same line instead of starting a new one.
        <p className="caption-text text-white/90">
          {text}
          {pending && (
            <>
              {text && " "}
              <span className="text-white/40">{pending}</span>
            </>
          )}
        </p>
      ) : (
        <p className="grid h-full place-items-center text-center text-sm text-white/20">
          {placeholder}
        </p>
      )}
    </div>
  );
}
