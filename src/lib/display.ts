/**
 * Display settings the viewer can change from the settings panel.
 *
 * Three layers decide what the caption looks like, each overriding the one
 * before it:
 *
 *   1. a fallback baked into `globals.css`, for the moment before hydration;
 *   2. the `.env` defaults, rendered by the server as custom properties on
 *      `<html>`;
 *   3. the viewer's own overrides, written to `<body>` from `localStorage`.
 *
 * Because `<body>` is inside `<html>`, a property set on the body wins for
 * everything on the page, and clearing it falls straight back to the `.env`
 * value — which is what the panel's reset button does. No layer has to know
 * about the others.
 *
 * These overrides are shared across every tab on this origin, same as the
 * combined-display app this one split off from — a font choice made on the
 * transcribe tab should look right if that tab is later switched to
 * translate. Shared *live*, at that: the store below listens for the
 * `storage` event, so a change made in one tab lands on every other one
 * within the same frame rather than waiting for each of them to be reloaded.
 * That matters here more than it would in most apps, since the other tab is
 * typically a second monitor or an OBS browser source that nobody is sitting
 * in front of to refresh. What is *not* shared is which pane a tab shows at
 * all: that lives in `sessionStorage`, one tab at a time — see
 * `src/lib/tab-mode.ts`.
 */

import { CAPTION_CSS_VARS } from "@/lib/caption";
import { subscribeStorageKey } from "@/lib/cross-tab";

/** Bumped only if the stored shape changes in a way older data cannot satisfy. */
export const STORAGE_KEY = "nectec.caption.v1";

/**
 * The settings the panel exposes. Line height, weight, tracking and scroll
 * motion stay in `.env`: they are set once for an installation, while these get
 * adjusted for the room the screen is standing in.
 *
 * `fontScale` is the only entry that never reaches CSS — it is the slider's own
 * position, kept because `fontSize` is a generated `clamp()` that cannot be
 * read back as a single number.
 */
export interface DisplayOverrides {
  fontFamily?: string;
  fontSize?: string;
  fontScale?: number;
  /** Unitless multiple of the font size, the way CSS `line-height` wants it. */
  lineHeight?: number;
  /** Read by React rather than CSS — it decides what is rendered at all. */
  showPartial?: boolean;
  /** Extra blank room below the text, in `vh` — see `BOTTOM_GAP_RANGE` below
   *  and the caption pane's `padding-bottom` in `globals.css`. */
  bottomGap?: number;
}

export type DisplayKey = keyof DisplayOverrides;

/** Which overrides land on a custom property, and which one is bookkeeping. */
const CSS_TARGETS: Partial<Record<DisplayKey, string>> = {
  fontFamily: CAPTION_CSS_VARS.fontFamily,
  fontSize: CAPTION_CSS_VARS.fontSize,
  lineHeight: CAPTION_CSS_VARS.lineHeight,
  bottomGap: CAPTION_CSS_VARS.bottomGap,
};

/** Same guard the server applies to `.env`: a value must not escape its declaration. */
const UNSAFE = /[;{}<>]/;

/**
 * The window the slider's number is quoted at. Pick 2rem on a 1280×800 screen
 * and the caption renders at exactly 2rem there, growing from that — the
 * reference is what makes the number mean something.
 */
const REFERENCE_WIDTH = 1280;
const REFERENCE_HEIGHT = 800;

/** `1rem` at the reference window, expressed in each viewport unit. */
const VW_PER_REM = (16 / REFERENCE_WIDTH) * 100;
const VH_PER_REM = (16 / REFERENCE_HEIGHT) * 100;

/** How far the size may fall below and rise above the quoted value. */
const SIZE_FLOOR = 0.55;
const SIZE_CEILING = 2.2;

/**
 * Builds a font size that tracks the viewport.
 *
 * A caption screen is never one size — the same page runs on a laptop while
 * being set up and on a projector once the hall fills. The floor keeps it
 * legible on a phone; the ceiling stops a 4K wall from rendering three words
 * per line.
 *
 * Width and height both get a say, and the smaller wins. Scaling on width
 * alone looks right until the display is a short, wide strip above a stage,
 * where 48px type would leave three lines of room — the height term is what
 * keeps a 2560×720 banner readable.
 */
export function buildFontSize(scale: number): string {
  const min = (scale * SIZE_FLOOR).toFixed(3);
  const byWidth = (scale * VW_PER_REM).toFixed(4);
  const byHeight = (scale * VH_PER_REM).toFixed(4);
  const max = (scale * SIZE_CEILING).toFixed(3);

  return `clamp(${min}rem, min(${byWidth}vw, ${byHeight}vh), ${max}rem)`;
}

/**
 * The scale that reproduces a size already on screen.
 *
 * Opening the panel must not move the caption: whatever `.env` asked for gets
 * measured, and the slider starts at the scale that renders the same size in
 * this window. Mirrors `buildFontSize`, min() included, or the slider would
 * jump the moment the height term is the binding one.
 */
export function scaleFromRenderedPx(px: number): number {
  const perScale = Math.min(
    (VW_PER_REM * window.innerWidth) / 100,
    (VH_PER_REM * window.innerHeight) / 100,
  );

  return perScale > 0 ? px / perScale : 1;
}

export interface FontChoice {
  value: string;
  label: string;
  /** False for the families that cannot draw Thai, which the picker flags. */
  thai: boolean;
}

/**
 * Only families the app already bundles — see `src/app/fonts.ts`, which has to
 * declare every custom property named here. A free-text CSS box would let the
 * operator name a font the viewing machine does not have, and the caption would
 * quietly fall back to something different on every screen.
 *
 * Ordered by how the letterforms read rather than alphabetically: the two
 * Latin-only faces sit at the end because picking one drops Thai onto whatever
 * the system supplies.
 */
export const FONT_CHOICES: FontChoice[] = [
  {
    value: "var(--font-caption), sans-serif",
    label: "Prompt — เรขาคณิต โปร่ง",
    thai: true,
  },
  {
    value: "var(--font-sarabun), sans-serif",
    label: "Sarabun — ทางการ ราชการ",
    thai: true,
  },
  {
    value: "var(--font-plex-thai), sans-serif",
    label: "IBM Plex Sans Thai — องค์กร",
    thai: true,
  },
  {
    value: "var(--font-noto-thai), sans-serif",
    label: "Noto Sans Thai — กลาง ๆ",
    thai: true,
  },
  {
    value: "var(--font-kanit), sans-serif",
    label: "Kanit — หนา เห็นชัด",
    thai: true,
  },
  {
    value: "var(--font-mitr), sans-serif",
    label: "Mitr — กลม อ่านไกล",
    thai: true,
  },
  {
    value: "var(--font-bai-jamjuree), sans-serif",
    label: "Bai Jamjuree — เหลี่ยม เทคนิค",
    thai: true,
  },
  {
    value: "var(--font-noto-serif-thai), serif",
    label: "Noto Serif Thai — มีเชิง",
    thai: true,
  },
  {
    value: "var(--font-trirong), serif",
    label: "Trirong — มีเชิง คมกว่า",
    thai: true,
  },
  {
    value: "var(--font-geist-sans), sans-serif",
    label: "Geist Sans — ละตินเท่านั้น",
    thai: false,
  },
  {
    value: "var(--font-geist-mono), monospace",
    label: "Geist Mono — ละตินเท่านั้น",
    thai: false,
  },
];

/** Roughly "readable at a desk" to "readable from the back of a hall". */
export const FONT_SCALE_RANGE = { min: 0.6, max: 4.5, step: 0.05 };

/**
 * Line spacing, as a multiple of the font size. Thai stacks vowel and tone
 * marks above and below the letters, so it needs more room than Latin before
 * lines start colliding — hence a floor well above the usual 1.2.
 */
export const LINE_HEIGHT_RANGE = { min: 1.3, max: 3.2, step: 0.05 };

/**
 * How far the text may be pushed up off the bottom edge, in `vh`. `0` is the
 * original, unadjusted display; the ceiling is generous enough to clear a
 * sizeable lower-third without leaving so little vertical room that a normal
 * sentence has nowhere to sit.
 */
export const BOTTOM_GAP_RANGE = { min: 0, max: 30, step: 1 };

function isUsableString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !UNSAFE.test(value);
}

function isUsableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsable(value: unknown): boolean {
  return isUsableString(value) || isUsableNumber(value);
}

export function readOverrides(): DisplayOverrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const source = parsed as Record<string, unknown>;
    const result: DisplayOverrides = {};

    if (isUsableString(source.fontFamily)) {
      result.fontFamily = source.fontFamily;
    }
    if (isUsableString(source.fontSize)) {
      result.fontSize = source.fontSize;
    }
    if (isUsableNumber(source.fontScale)) {
      result.fontScale = source.fontScale;
    }
    if (isUsableNumber(source.lineHeight)) {
      result.lineHeight = Math.min(
        LINE_HEIGHT_RANGE.max,
        Math.max(LINE_HEIGHT_RANGE.min, source.lineHeight),
      );
    }
    if (typeof source.showPartial === "boolean") {
      result.showPartial = source.showPartial;
    }
    if (isUsableNumber(source.bottomGap)) {
      result.bottomGap = Math.min(
        BOTTOM_GAP_RANGE.max,
        Math.max(BOTTOM_GAP_RANGE.min, source.bottomGap),
      );
    }

    return result;
  } catch {
    // Private mode, a full quota, or hand-edited rubbish — the `.env` values
    // are a perfectly good place to land.
    return {};
  }
}

export function writeOverrides(overrides: DisplayOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Saving is a convenience; the change is already on screen either way.
  }
}

/** Pushes the overrides onto `<body>`, clearing any the viewer has reset. */
export function applyOverrides(overrides: DisplayOverrides): void {
  const { style } = document.body;

  for (const [key, property] of Object.entries(CSS_TARGETS)) {
    const value = overrides[key as DisplayKey];
    if (property && isUsable(value)) {
      style.setProperty(property, String(value));
    } else if (property) {
      style.removeProperty(property);
    }
  }
}

/**
 * The overrides as a subscribable store.
 *
 * Most settings reach the screen as custom properties, which React never has
 * to know about. `showPartial` is different — it decides whether a piece of
 * text is rendered at all — so the display has to re-render when it changes,
 * and both the panel and the stage need to agree on one copy.
 *
 * The server snapshot is empty rather than the stored value: `localStorage`
 * does not exist while rendering, and the `.env` defaults are what the markup
 * is built from.
 */
const EMPTY_OVERRIDES: DisplayOverrides = {};

let cached: DisplayOverrides | null = null;
const listeners = new Set<() => void>();
/** Live only while something is subscribed — see `subscribeOverrides`. */
let stopStorageSync: (() => void) | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Takes on the overrides another tab just saved.
 *
 * `setOverrides` without the write-back: the tab that made the change has
 * already stored it, and storing it again from here would be a redundant
 * write of a value that is by definition already what is on disk.
 *
 * The re-read goes through `readOverrides` rather than the event's own
 * `newValue` so a value arriving from another tab is validated and clamped by
 * exactly the same code that validates one read at startup — a hand-edited
 * `localStorage` entry must not reach the DOM just because it took the
 * cross-tab route in.
 */
function adoptStoredOverrides(): void {
  cached = readOverrides();
  applyOverrides(cached);
  notify();
}

/**
 * Subscribes to override changes — this tab's own and, since these settings
 * describe the screen rather than the tab, those made in any other tab on this
 * origin. The cross-tab listener is attached with the first subscriber and
 * dropped with the last, so nothing is listening on a page that never reads
 * the store.
 */
export function subscribeOverrides(listener: () => void): () => void {
  if (listeners.size === 0) {
    stopStorageSync = subscribeStorageKey(STORAGE_KEY, adoptStoredOverrides);
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

export function overridesSnapshot(): DisplayOverrides {
  cached ??= readOverrides();
  return cached;
}

export const serverOverridesSnapshot = (): DisplayOverrides => EMPTY_OVERRIDES;

/** Stores the overrides, paints them, and tells every subscriber. */
export function setOverrides(next: DisplayOverrides): void {
  cached = next;
  applyOverrides(next);
  writeOverrides(next);
  notify();
}

/**
 * Resolves a CSS length to pixels by measuring it.
 *
 * The `.env` default may be a `clamp()` or a viewport unit, which no amount of
 * string parsing turns into a number — but the sliders still have to start
 * somewhere sensible, so the browser is asked to do the arithmetic.
 */
export function resolveFontPx(value: string): number {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.fontSize = value;

  document.body.appendChild(probe);
  const px = Number.parseFloat(window.getComputedStyle(probe).fontSize);
  probe.remove();

  return Number.isFinite(px) ? px : 0;
}

/** The scale that matches a font size currently in force, measured live. */
export function currentFontScale(fallback: string): number {
  return scaleFromRenderedPx(resolveFontPx(fallback));
}

/**
 * The line spacing the caption is rendering at, as a multiple of its font size.
 *
 * Measured off a real `.caption-text` element rather than parsed from `.env`,
 * because the configured value is free-form CSS: it may be a bare ratio, a
 * length like `2.75rem`, or the keyword `normal`, and only the browser knows
 * what any of those come out as next to the current font.
 */
export function currentLineHeightRatio(fallbackRatio = 1.9): number {
  const probe = document.createElement("p");
  probe.className = "caption-text";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.textContent = "x";

  document.body.appendChild(probe);
  const style = window.getComputedStyle(probe);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const fontSize = Number.parseFloat(style.fontSize);
  probe.remove();

  // `line-height: normal` computes to the keyword, not a length.
  if (!Number.isFinite(lineHeight) || !Number.isFinite(fontSize) || fontSize <= 0) {
    return fallbackRatio;
  }

  return lineHeight / fontSize;
}

/**
 * Applies saved overrides before the first paint.
 *
 * Inlined into the document by the root layout rather than run from an effect:
 * React mounts after the browser has already painted, so an effect would show
 * one frame at the `.env` size and then jump — the exact reflow this project
 * has avoided since the desktop build it descends from.
 */
export const BOOTSTRAP_SCRIPT = `(function(){try{var r=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});if(!r)return;var o=JSON.parse(r);var m=${JSON.stringify(
  CSS_TARGETS,
)};var s=document.body.style;for(var k in m){var v=o[k];if(typeof v==="number"&&isFinite(v)){s.setProperty(m[k],String(v))}else if(typeof v==="string"&&v&&!/[;{}<>]/.test(v)){s.setProperty(m[k],v)}}}catch(e){}})()`;
