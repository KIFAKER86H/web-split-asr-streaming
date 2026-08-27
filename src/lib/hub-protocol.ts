/**
 * The message shapes spoken over the `MessagePort` between a tab and the
 * SharedWorker hub at `public/workers/caption-hub.js`.
 *
 * This file is the type-checked half of the contract, imported by
 * `useCaptionHub.ts`. The worker itself is a plain `.js` file served as a
 * static asset — Next.js has no built-in way to bundle a `SharedWorker`
 * script from TypeScript, and reaching for one would mean teaching webpack or
 * Turbopack a second entry point just for ~300 lines of code that has to run
 * in a global scope with no DOM anyway (see that file's own header comment).
 * So the two are kept in sync by hand, the same way `public/worklets/
 * pcm-recorder.js` already is for the audio pipeline. **Changing a message
 * shape here means changing it there too.**
 *
 * One hub instance is shared by every tab open on this origin (that is the
 * entire point of `SharedWorker` over a plain `Worker`), so it is the single
 * place the transcription session and the translation queue actually live.
 * A tab that captures no audio and translates nothing can still show a full
 * transcript the instant it opens, because the hub replies to `hello` with
 * whatever it already has.
 */

export interface CaptionTurn {
  /** Unique across recordings — see `useAssemblyStream` in the combined app. */
  id: string;
  text: string;
  isFormatted: boolean;
}

export type HubStreamStatus = "idle" | "connecting" | "streaming";

/**
 * Which configured API set is currently in use — `1` is the default
 * (unsuffixed) `.env` values, `2` is the `_B`-suffixed alternate. Declared
 * here rather than imported from `src/lib/server/config.ts`: that module
 * reads `process.env` and is meant to stay server-only, and this bare `1 | 2`
 * is the only part of it either the tab or the worker actually needs.
 */
export type ApiSlot = 1 | 2;

export type TranslationStatus = "unknown" | "off" | "idle" | "translating";

export interface TranslationState {
  /** Finished translations plus whatever is streaming, as one flowing string. */
  text: string;
  status: TranslationStatus;
  error: string | null;
}

/**
 * Everything the hub knows, broadcast whole on every change.
 *
 * The alternative — patch messages that add one turn or append one delta — was
 * considered and dropped: a transcript is at most a few kilobytes, the port is
 * local (no network, no serialisation cost worth optimising), and a full
 * snapshot means a tab that reconnects mid-session or opens for the first time
 * needs exactly one message type to catch up instead of two.
 */
export interface HubState {
  status: HubStreamStatus;
  turns: CaptionTurn[];
  /** The turn still being spoken; empty between turns. */
  partial: string;
  /** A transcription-side problem (mic, socket, token). */
  error: string | null;
  translation: TranslationState;
  /** Wall-clock length of the current (or most recent) recording. */
  elapsedMs: number;
  /** `tabId` of the tab currently feeding the hub audio, or `null` if none. */
  producerId: string | null;
  /** Which API set transcription and translation are currently reading from. */
  activeSlot: ApiSlot;
  /** `2` once a second API set is actually configured in `.env`; `1` otherwise
   *  — the gate the slot-swap hotkey checks before doing anything at all. */
  slotCount: ApiSlot;
}

export const IDLE_TRANSLATION: TranslationState = {
  text: "",
  status: "unknown",
  error: null,
};

export const INITIAL_HUB_STATE: HubState = {
  status: "idle",
  turns: [],
  partial: "",
  error: null,
  translation: IDLE_TRANSLATION,
  elapsedMs: 0,
  producerId: null,
  activeSlot: 1,
  slotCount: 1,
};

/**
 * Selects the recognition language(s) — mirrors `StreamProfile` in
 * `src/lib/aai.ts`, trimmed to the one field `buildSocketUrl` needs. The
 * profile is chosen on the page (`STREAM_PROFILES[0]`, same as the combined
 * app) and only carried through the message; the hub never has to know the
 * full list.
 */
export interface HubStreamProfile {
  speechModel: string;
  languageCodes?: string[];
  languageDetection?: boolean;
}

// ─── Tab → hub ───────────────────────────────────────────────────────────

export interface HelloMessage {
  type: "hello";
  tabId: string;
}

/** Heartbeat — see the header comment in `caption-hub.js` for why this exists. */
export interface PingMessage {
  type: "ping";
  tabId: string;
}

/** Sent from `pagehide`; best-effort, the heartbeat is the real backstop. */
export interface ByeMessage {
  type: "bye";
  tabId: string;
}

/** "I would like to be the one whose microphone feeds the hub." */
export interface ClaimProducerMessage {
  type: "claim-producer";
  tabId: string;
}

/** Sent once local mic capture is up and the socket should be opened. */
export interface BeginStreamMessage {
  type: "begin-stream";
  tabId: string;
  profile: HubStreamProfile;
}

/** One 100 ms chunk of 16-bit PCM, transferred rather than copied. */
export interface PcmMessage {
  type: "pcm";
  tabId: string;
  buffer: ArrayBuffer;
}

/** Mic loudness, throttled by the sender — see `useCaptionHub.ts`. */
export interface LevelMessage {
  type: "level";
  tabId: string;
  value: number;
}

/**
 * "Stop the session." May come from the producer tab itself or from any other
 * tab — the mic button works the same in every tab regardless of which one is
 * actually recording.
 */
export interface RequestStopMessage {
  type: "request-stop";
  tabId: string;
}

export interface ClearMessage {
  type: "clear";
  tabId: string;
}

/**
 * "Switch transcribe + translate over to the other configured API set."
 * A no-op at the hub if `slotCount` is still `1` — see `transcribeSlotCount`
 * in `src/lib/server/config.ts`. May come from any tab, streaming or not;
 * see the header comment above `handleSwapSlot` in `caption-hub.js` for what
 * happens while a recording is actually live.
 */
export interface SwapSlotMessage {
  type: "swap-slot";
  tabId: string;
}

export type ToHubMessage =
  | HelloMessage
  | PingMessage
  | ByeMessage
  | ClaimProducerMessage
  | BeginStreamMessage
  | PcmMessage
  | LevelMessage
  | RequestStopMessage
  | ClearMessage
  | SwapSlotMessage;

// ─── Hub → tab ───────────────────────────────────────────────────────────

/** Broadcast to every connected tab whenever anything changes. */
export interface StateMessage {
  type: "state";
  state: HubState;
}

/** Broadcast at a throttled rate whenever the producer reports its level. */
export interface LevelBroadcast {
  type: "level";
  value: number;
}

/** Private reply to `claim-producer`, sent only to the tab that asked. */
export interface ProducerResultMessage {
  type: "producer-result";
  granted: boolean;
  reason?: string;
}

/**
 * Private instruction to the current producer: let go of the microphone. Sent
 * when any tab asks to stop, when the hub itself gives up on the socket, or
 * when a second tab's `claim-producer` forces a hand-off is *not* supported —
 * see the "only one producer at a time" note in `caption-hub.js`.
 */
export interface ReleaseMicMessage {
  type: "release-mic";
}

export type FromHubMessage =
  | StateMessage
  | LevelBroadcast
  | ProducerResultMessage
  | ReleaseMicMessage;
