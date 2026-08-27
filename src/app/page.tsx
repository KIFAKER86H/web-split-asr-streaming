import { CaptionStage } from "@/components/CaptionStage";

/**
 * The single page of the app — every tab loads the same route.
 *
 * What a tab actually shows (transcribe or translate) is not a route at all;
 * it is a per-tab choice read from `sessionStorage` (or `?mode=` on first
 * load) inside `CaptionStage`. That is what lets two tabs — or two OBS
 * browser sources — point at this exact URL and still show different panes:
 * see `src/lib/tab-mode.ts`.
 *
 * Configuration is read once in the root layout, which also renders it into
 * the document as custom properties — nothing else is left for this route
 * to do.
 */
export default function Home() {
  return <CaptionStage />;
}
