/**
 * Reads and validates the runtime configuration.
 *
 * Server-only — every function here touches `process.env`, which carries no
 * values in the browser. This is the file the desktop build reimplemented as
 * `src-tauri/src/config.rs`; the rules, the ranges and the fallbacks are the
 * same, so a `.env` written for one runs unchanged on the other.
 *
 * Nothing is cached: the page and the route handlers are rendered per request,
 * so editing `.env` and restarting the server is enough — no rebuild.
 */

import { DEFAULT_TOKEN_ENDPOINT, DEFAULT_WS_ENDPOINT } from "@/lib/aai";
import type { ConfigSource } from "@/lib/caption";

/** Redeemable window for a temporary token, in seconds. */
const EXPIRES_IN_DEFAULT = 60;
const EXPIRES_IN_RANGE: [number, number] = [1, 600];

/** Hard ceiling on one streaming session, in seconds. */
const MAX_SESSION_DEFAULT = 3600;
const MAX_SESSION_RANGE: [number, number] = [60, 10_800];

/** See `TextConfig.contextTokens`. */
const CONTEXT_TOKENS_DEFAULT = 128;
const CONTEXT_TOKENS_RANGE: [number, number] = [0, 32_768];

function read(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/**
 * A whole number inside `range`, or `fallback`.
 *
 * Out-of-range values are rejected rather than clamped: a `.env` asking for a
 * 4-hour session is a mistake worth seeing in the log, and silently serving 3
 * hours instead would hide it.
 */
function readNumber(
  name: string,
  fallback: number,
  [min, max]: [number, number],
): number {
  const raw = read(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(
      `[NECTEC Live Transcribe] ${name} ต้องเป็นจำนวนเต็ม ${min}–${max} — ได้รับ "${raw}" ใช้ ${fallback} แทน`,
    );
    return fallback;
  }

  return value;
}

/** Which configuration to read — `2` reads the `_B`-suffixed alternate set. */
export type ApiSlot = 1 | 2;

/** `""` for slot 1, `"_B"` for slot 2 — every slot-aware reader shares this. */
function slotSuffix(slot: ApiSlot): string {
  return slot === 2 ? "_B" : "";
}

/** Reads `?slot=` off a request URL — anything but `"2"` is slot 1. */
export function parseApiSlot(searchParams: URLSearchParams): ApiSlot {
  return searchParams.get("slot") === "2" ? 2 : 1;
}

export interface StreamConfig {
  tokenEndpoint: string;
  wsEndpoint: string;
  /** Empty when the endpoint accepts unauthenticated connections. */
  apiKey: string;
  expiresInSeconds: number;
  maxSessionSeconds: number;
}

/** Everything `/api/token` needs to mint a streaming token. */
export function streamConfig(slot: ApiSlot = 1): StreamConfig {
  const suffix = slotSuffix(slot);
  return {
    tokenEndpoint:
      read(`ASSEMBLYAI_TOKEN_ENDPOINT${suffix}`) || DEFAULT_TOKEN_ENDPOINT,
    wsEndpoint: read(`ASSEMBLYAI_WS_ENDPOINT${suffix}`) || DEFAULT_WS_ENDPOINT,
    apiKey: read(`ASSEMBLYAI_API_KEY${suffix}`),
    expiresInSeconds: readNumber(
      `ASSEMBLYAI_TOKEN_EXPIRES_IN${suffix}`,
      EXPIRES_IN_DEFAULT,
      EXPIRES_IN_RANGE,
    ),
    maxSessionSeconds: readNumber(
      `ASSEMBLYAI_MAX_SESSION_SECONDS${suffix}`,
      MAX_SESSION_DEFAULT,
      MAX_SESSION_RANGE,
    ),
  };
}

/**
 * Whether a second transcribe API set is configured at all — the gate for the
 * whole slot-swap feature (`F3` by default; see `src/lib/hotkeys.ts`).
 *
 * `ASSEMBLYAI_WS_ENDPOINT_B` is the one setting that has to be deliberate for
 * a second slot to mean anything (a different backend, a different region, or
 * at minimum an explicit opt-in with the same host) — every other `_B`
 * variable already has a sensible fallback on its own, so checking those
 * instead would risk "detecting" a slot 2 nobody meant to set up.
 */
export function transcribeSlotCount(): 1 | 2 {
  return read("ASSEMBLYAI_WS_ENDPOINT_B") ? 2 : 1;
}

export interface TextConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Soft budget, in approximate tokens, for how much prior (source,
   *  translation) history `/api/translate` folds into the prompt as
   *  conversational context — `0` translates each turn in isolation, same as
   *  before this existed. See `trimContext` in
   *  `src/app/api/translate/route.ts` for how the budget is spent. */
  contextTokens: number;
}

/**
 * Settings for the translation model, or `null` when `TEXT_BASE_URL` and
 * `TEXT_MODEL_NAME` are not both set.
 *
 * Translation is optional, so an absent configuration is a normal state rather
 * than a failure — the lower pane simply shows its placeholder.
 */
export function textConfig(slot: ApiSlot = 1): TextConfig | null {
  const suffix = slotSuffix(slot);
  const baseUrl = read(`TEXT_BASE_URL${suffix}`);
  const model = read(`TEXT_MODEL_NAME${suffix}`);

  if (!baseUrl || !model) {
    return null;
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new Error(
      `TEXT_BASE_URL${suffix} ไม่ใช่ URL ที่ถูกต้อง — ได้รับ "${baseUrl}" ต้องขึ้นต้นด้วย http:// หรือ https://`,
    );
  }

  return {
    baseUrl,
    apiKey: read(`TEXT_API_KEY${suffix}`),
    model,
    contextTokens: readNumber(
      `CONTEXT_TOKENS${suffix}`,
      CONTEXT_TOKENS_DEFAULT,
      CONTEXT_TOKENS_RANGE,
    ),
  };
}

/**
 * The raw strings handed to `resolveCaptionSettings` by the page — mostly
 * `CAPTION_*`, plus `ASSEMBLYAI_CHUNK_MS` (see `audioChunkMs` in
 * `src/lib/caption.ts` for why that one rides along here instead of living
 * with the rest of the `ASSEMBLYAI_*` block above).
 *
 * Listed one by one rather than passing `process.env` wholesale: the result is
 * serialised into the page for the client, and the environment of a server has
 * no business travelling there.
 */
export function captionConfig(): ConfigSource {
  return {
    CAPTION_FONT_FAMILY: read("CAPTION_FONT_FAMILY"),
    CAPTION_FONT_SIZE: read("CAPTION_FONT_SIZE"),
    CAPTION_LINE_HEIGHT: read("CAPTION_LINE_HEIGHT"),
    CAPTION_FONT_WEIGHT: read("CAPTION_FONT_WEIGHT"),
    CAPTION_LETTER_SPACING: read("CAPTION_LETTER_SPACING"),
    CAPTION_SHOW_PARTIAL: read("CAPTION_SHOW_PARTIAL"),
    CAPTION_SCROLL_MOTION: read("CAPTION_SCROLL_MOTION"),
    CAPTION_BOTTOM_GAP: read("CAPTION_BOTTOM_GAP"),
    ASSEMBLYAI_CHUNK_MS: read("ASSEMBLYAI_CHUNK_MS"),
  };
}
