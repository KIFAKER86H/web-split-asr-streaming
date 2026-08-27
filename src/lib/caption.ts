export interface CaptionTypography {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: string;
  letterSpacing: string;
}

/**
 * `auto` follows the operating system's reduced-motion preference, the other
 * two override it. A caption display is often a kiosk whose OS has animations
 * switched off for unrelated reasons, so the operator needs the last word.
 */
export type ScrollMotion = "auto" | "smooth" | "reduced";

export interface CaptionSettings {
  typography: CaptionTypography;
  /**
   * Whether the sentence still being spoken appears before it is finished.
   * Off by default: an interim result rewrites itself as the recogniser
   * changes its mind, and text that edits itself under a reader is harder to
   * follow than text that simply arrives a beat later. Only the transcribe
   * display uses this — a translated turn is never partial.
   */
  showPartial: boolean;
  scrollMotion: ScrollMotion;
  /**
   * Extra room left blank below the text, in `vh` — on top of the fixed
   * breathing room the pane always keeps. Raises the caption up off the
   * bottom edge, for a screen that shares the frame with something else
   * sitting below it (a lower-third, a taskbar, another OBS source).
   * `0` matches the original, unadjusted display.
   */
  bottomGap: number;
  /**
   * Not a caption setting at all — how many milliseconds of microphone audio
   * the recorder worklet batches into one chunk before handing it to the hub
   * (`50`–`1000`, AssemblyAI's own accepted window). It rides along in this
   * object anyway because `CaptionSettings` is already the one channel that
   * gets a `.env` value to the client synchronously at first render — see
   * `useCaptionSettings` — and `useCaptionHub`'s `AudioWorkletNode` needs this
   * before it can even open, well before any request it could otherwise come
   * back on. See the header comment in `public/worklets/pcm-recorder.js` for
   * what actually turns this into a sample count.
   */
  audioChunkMs: number;
}

/**
 * Where each setting lands as a custom property.
 *
 * Typography reaches the screen through CSS variables rather than React props
 * so that changing it costs a style recalculation instead of a re-render of a
 * pane holding a long transcript — and so the pre-paint bootstrap script can
 * apply a saved override before React has run at all.
 *
 * Unlike the combined-display app this one split off from, there is no
 * `--caption-split` property here: each tab renders exactly one pane full
 * screen, so there is nothing to divide.
 */
export const CAPTION_CSS_VARS = {
  fontFamily: "--caption-font-family",
  fontSize: "--caption-font-size",
  lineHeight: "--caption-line-height",
  fontWeight: "--caption-font-weight",
  letterSpacing: "--caption-letter-spacing",
  bottomGap: "--caption-bottom-gap",
} as const;

/** The settings as custom properties, ready to sit on an element's `style`. */
export function captionCssVars(settings: CaptionSettings): Record<string, string> {
  return {
    [CAPTION_CSS_VARS.fontFamily]: settings.typography.fontFamily,
    [CAPTION_CSS_VARS.fontSize]: settings.typography.fontSize,
    [CAPTION_CSS_VARS.lineHeight]: settings.typography.lineHeight,
    [CAPTION_CSS_VARS.fontWeight]: settings.typography.fontWeight,
    [CAPTION_CSS_VARS.letterSpacing]: settings.typography.letterSpacing,
    // Unitless — `globals.css` multiplies it by `1vh` at the point of use, the
    // same trick `--caption-line-height` relies on to stay a bare number.
    [CAPTION_CSS_VARS.bottomGap]: String(settings.bottomGap),
  };
}

/**
 * Raw `.env` strings this settles from — mostly `CAPTION_*`, plus
 * `ASSEMBLYAI_CHUNK_MS` (see `audioChunkMs` above for why it rides along
 * here instead of living with the rest of the `ASSEMBLYAI_*` block in
 * `src/lib/server/config.ts`).
 */
export type ConfigSource = Record<string, string | undefined>;

/**
 * Prompt is bundled by the root layout and covers Thai and Latin in one family.
 * The light weight and slight tracking are what give the display its airiness —
 * at 400 with no tracking it reads as a plain UI screen instead.
 */
const DEFAULT_TYPOGRAPHY: CaptionTypography = {
  fontFamily: "var(--font-caption), var(--font-geist-sans), sans-serif",
  /**
   * Scales with the viewport rather than sitting at a fixed size: the display
   * fills the screen, and the same page has to read on a laptop and on a hall
   * projector. Tuned to land on 2rem in a 1280×800 window, bounded by whichever
   * of width or height is tighter — see `buildFontSize` in
   * `src/lib/display.ts`, which generates the same shape from the slider.
   */
  fontSize: "clamp(1.1rem, min(2.5vw, 4vh), 4.4rem)",
  lineHeight: "1.9",
  fontWeight: "300",
  letterSpacing: "0.01em",
};

/** How far the bottom-gap setting is allowed to push, in `vh` — see
 *  `BOTTOM_GAP_RANGE` in `src/lib/display.ts`, which the F2 slider shares. */
const BOTTOM_GAP_LIMIT: [number, number] = [0, 30];

/** AssemblyAI's own accepted chunk-duration window, in ms. */
const AUDIO_CHUNK_MS_LIMIT: [number, number] = [50, 1000];

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
  typography: DEFAULT_TYPOGRAPHY,
  showPartial: false,
  scrollMotion: "auto",
  bottomGap: 0,
  // 1600 samples at the 16 kHz the worklet always records at — the value
  // that shipped before this became configurable.
  audioChunkMs: 100,
};

const SCROLL_MOTIONS: ScrollMotion[] = ["auto", "smooth", "reduced"];

/** Characters that would let a value escape the declaration it lands in. */
const UNSAFE = /[;{}<>]/;

function readCss(source: ConfigSource, name: string, fallback: string): string {
  const value = source[name]?.trim();
  if (!value) {
    return fallback;
  }

  if (UNSAFE.test(value)) {
    console.warn(
      `[NECTEC Live Transcribe] ${name} มีอักขระที่ใช้ใน CSS ไม่ได้ — ใช้ค่าเริ่มต้นแทน`,
    );
    return fallback;
  }

  return value;
}

const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

function readBoolean(
  source: ConfigSource,
  name: string,
  fallback: boolean,
): boolean {
  const value = source[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }

  if (TRUTHY.includes(value)) {
    return true;
  }
  if (FALSY.includes(value)) {
    return false;
  }

  console.warn(
    `[NECTEC Live Transcribe] ${name} ต้องเป็น true/false — ได้รับ "${value}" ใช้ ${fallback} แทน`,
  );
  return fallback;
}

/** Mirrors `readNumber` in `src/lib/server/config.ts` — rejects rather than
 *  clamps an out-of-range value, so a typo in `.env` shows up in the log
 *  instead of silently landing on whatever the nearest bound happens to be. */
function readNumberInRange(
  source: ConfigSource,
  name: string,
  fallback: number,
  [min, max]: [number, number],
): number {
  const raw = source[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(
      `[NECTEC Live Transcribe] ${name} ต้องเป็นตัวเลข ${min}–${max} — ได้รับ "${raw}" ใช้ ${fallback} แทน`,
    );
    return fallback;
  }

  return value;
}

function readScrollMotion(source: ConfigSource): ScrollMotion {
  const value = source.CAPTION_SCROLL_MOTION?.trim().toLowerCase();
  if (!value) {
    return "auto";
  }

  if (!SCROLL_MOTIONS.includes(value as ScrollMotion)) {
    console.warn(
      `[NECTEC Live Transcribe] CAPTION_SCROLL_MOTION ต้องเป็น ${SCROLL_MOTIONS.join(" / ")} — ได้รับ "${value}" ใช้ auto แทน`,
    );
    return "auto";
  }

  return value as ScrollMotion;
}

/**
 * Turns raw config strings into settings.
 *
 * Pure on purpose: the page reads `.env` on the server and passes the raw
 * strings in. Nothing here touches `process.env`, so the same function runs
 * unchanged in the browser.
 */
export function resolveCaptionSettings(source: ConfigSource): CaptionSettings {
  return {
    typography: {
      fontFamily: readCss(
        source,
        "CAPTION_FONT_FAMILY",
        DEFAULT_TYPOGRAPHY.fontFamily,
      ),
      fontSize: readCss(source, "CAPTION_FONT_SIZE", DEFAULT_TYPOGRAPHY.fontSize),
      lineHeight: readCss(
        source,
        "CAPTION_LINE_HEIGHT",
        DEFAULT_TYPOGRAPHY.lineHeight,
      ),
      fontWeight: readCss(
        source,
        "CAPTION_FONT_WEIGHT",
        DEFAULT_TYPOGRAPHY.fontWeight,
      ),
      letterSpacing: readCss(
        source,
        "CAPTION_LETTER_SPACING",
        DEFAULT_TYPOGRAPHY.letterSpacing,
      ),
    },
    showPartial: readBoolean(source, "CAPTION_SHOW_PARTIAL", false),
    scrollMotion: readScrollMotion(source),
    bottomGap: readNumberInRange(
      source,
      "CAPTION_BOTTOM_GAP",
      DEFAULT_CAPTION_SETTINGS.bottomGap,
      BOTTOM_GAP_LIMIT,
    ),
    audioChunkMs: readNumberInRange(
      source,
      "ASSEMBLYAI_CHUNK_MS",
      DEFAULT_CAPTION_SETTINGS.audioChunkMs,
      AUDIO_CHUNK_MS_LIMIT,
    ),
  };
}
