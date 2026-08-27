"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SAMPLE_RATE, type StreamProfile } from "@/lib/aai";
import {
  INITIAL_HUB_STATE,
  type ApiSlot,
  type CaptionTurn,
  type FromHubMessage,
  type HubState,
  type HubStreamStatus,
  type ToHubMessage,
  type TranslationStatus,
} from "@/lib/hub-protocol";

export type { ApiSlot, CaptionTurn, HubStreamStatus, TranslationStatus };

/** Same file every tab connects to — one script, one shared instance per origin. */
const WORKER_URL = "/workers/caption-hub.js";
const WORKER_NAME = "nectec-caption-hub";

/** How often this tab tells the hub it is still alive — see the header
 *  comment in `public/workers/caption-hub.js` for why this exists at all. */
const PING_INTERVAL_MS = 5_000;

interface WorkletChunk {
  pcm: ArrayBuffer;
  level: number;
}

function describeStartError(cause: unknown): string {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "เบราว์เซอร์ไม่อนุญาตให้ใช้ไมโครโฟน — กดไอคอนกุญแจบนแถบที่อยู่แล้วอนุญาต Microphone";
      case "NotFoundError":
      case "OverconstrainedError":
        return "ไม่พบไมโครโฟนที่เลือก — เลือกอุปกรณ์อื่นจากรายการมุมขวาบน";
      case "NotReadableError":
        return "ไมโครโฟนถูกโปรแกรมอื่นใช้งานอยู่ — ปิดโปรแกรมนั้นแล้วลองใหม่";
      default:
        break;
    }
  }
  return cause instanceof Error ? cause.message : "เริ่มการถอดเสียงไม่สำเร็จ";
}

export interface UseCaptionHubResult {
  status: HubStreamStatus;
  turns: CaptionTurn[];
  /** `turns` joined into one flowing string — the transcribe pane's text. */
  transcript: string;
  partial: string;
  error: string | null;
  translationText: string;
  translationStatus: TranslationStatus;
  translationError: string | null;
  elapsedMs: number;
  /** Updated on every mic-level report; read it from an animation frame. */
  levelRef: React.RefObject<number>;
  /** Whether *this* tab is the one whose microphone is feeding the hub. */
  isProducer: boolean;
  /** Which API set transcription and translation are currently reading from. */
  activeSlot: ApiSlot;
  /** `2` once `.env` actually configures a second API set — see
   *  `transcribeSlotCount` in `src/lib/server/config.ts`. */
  slotCount: ApiSlot;
  start: () => void;
  stop: () => void;
  clear: () => void;
  /** Switches transcribe + translate over to the other configured API set.
   *  Does nothing if `slotCount` is still `1`. */
  swapSlot: () => void;
  /** `SharedWorker` does not exist in this browser (Safari, mainly). */
  hubUnsupported: boolean;
}

interface UseCaptionHubOptions {
  profile: StreamProfile;
  /** Empty string means "let the browser pick the default input". */
  deviceId: string;
  /** `CaptionSettings.audioChunkMs` — how much audio the worklet batches
   *  into one chunk before it reaches the hub. */
  audioChunkMs: number;
}

/**
 * The tab's connection to the caption hub.
 *
 * A single `SharedWorker` instance is shared by every tab open on this
 * origin, so `status`, `turns`, `partial` and the translation all arrive here
 * already synchronised with whichever tab (if any) is actually recording —
 * this hook never has to reconcile two sources of truth. What it *does* own
 * locally is the microphone: `getUserMedia` and the `AudioWorklet` only exist
 * on a window, never inside the worker, so `start()` captures audio right
 * here and streams it to the hub one 100 ms chunk at a time.
 */
export function useCaptionHub({
  profile,
  deviceId,
  audioChunkMs,
}: UseCaptionHubOptions): UseCaptionHubResult {
  const [state, setState] = useState<HubState>(INITIAL_HUB_STATE);
  const [hubUnsupported, setHubUnsupported] = useState(false);
  /**
   * A problem local to *this* tab's own attempt to start recording — a denied
   * microphone, or losing the race to become the producer. Kept apart from
   * `state.error`, which comes from the hub and is broadcast to every tab: the
   * hub re-broadcasts on a timer once a session is running (the elapsed-time
   * tick alone fires every 250 ms), and folding a local-only notice into that
   * same object would have it overwritten within a quarter second of being
   * shown.
   */
  const [localError, setLocalErrorState] = useState<string | null>(null);
  const localErrorTimerRef = useRef(0);

  const setLocalError = useCallback((message: string) => {
    window.clearTimeout(localErrorTimerRef.current);
    setLocalErrorState(message);
    localErrorTimerRef.current = window.setTimeout(() => {
      setLocalErrorState(null);
    }, 6_000);
  }, []);

  useEffect(() => () => window.clearTimeout(localErrorTimerRef.current), []);

  const portRef = useRef<MessagePort | null>(null);
  // A lazy initialiser rather than a ref set during render: it still runs
  // exactly once per mount, but `crypto.randomUUID()` is an impure call and
  // the render body proper must stay pure — a `useState` initialiser is
  // React's documented escape hatch for one-time, non-deterministic setup
  // like this.
  const [tabId] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const levelRef = useRef(0);
  const profileRef = useRef(profile);
  const deviceIdRef = useRef(deviceId);
  const audioChunkMsRef = useRef(audioChunkMs);
  const producerGrantRef = useRef<((granted: boolean, reason?: string) => void) | null>(
    null,
  );

  // Local audio pipeline — only ever populated while this tab is the producer.
  const contextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);

  useEffect(() => {
    audioChunkMsRef.current = audioChunkMs;
  }, [audioChunkMs]);

  const send = useCallback((message: ToHubMessage, transfer?: Transferable[]) => {
    if (transfer) {
      portRef.current?.postMessage(message, transfer);
    } else {
      portRef.current?.postMessage(message);
    }
  }, []);

  /** Tears down the local mic and audio graph — does not touch the hub. */
  const releaseLocalAudio = useCallback(() => {
    workletRef.current?.disconnect();
    workletRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    void contextRef.current?.close();
    contextRef.current = null;

    levelRef.current = 0;
  }, []);

  // ── Connect to the hub once per tab ───────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined" || !("SharedWorker" in window)) {
      // Browser-capability detection has to run post-mount: `window` does not
      // exist during server rendering, so the very first client render must
      // match that server output (nothing shown) before this effect can
      // safely reveal whether the browser actually supports `SharedWorker` —
      // exactly the "detect an external, client-only capability" case this
      // lint rule's own docs carve out as legitimate effect use.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHubUnsupported(true);
      return;
    }

    const worker = new SharedWorker(WORKER_URL, WORKER_NAME);
    const port = worker.port;
    portRef.current = port;

    port.onmessage = (event: MessageEvent<FromHubMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "state":
          setState(message.state);
          break;
        case "level":
          levelRef.current = message.value;
          break;
        case "producer-result":
          producerGrantRef.current?.(message.granted, message.reason);
          producerGrantRef.current = null;
          break;
        case "release-mic":
          releaseLocalAudio();
          break;
        default:
          break;
      }
    };
    // Explicit start alongside the implicit one `onmessage` triggers — see
    // the matching note on the hub side for why both browsers get this.
    port.start();
    port.postMessage({ type: "hello", tabId } satisfies ToHubMessage);

    const pingTimer = window.setInterval(() => {
      port.postMessage({ type: "ping", tabId } satisfies ToHubMessage);
    }, PING_INTERVAL_MS);

    // `pagehide` rather than `beforeunload`: both fire on a real close, but
    // only `pagehide` also fires when the page is about to enter the
    // back/forward cache — `beforeunload` is unreliable there in both
    // browsers and can suppress the cache entirely if relied on for cleanup.
    const handlePageHide = () => {
      try {
        port.postMessage({ type: "bye", tabId } satisfies ToHubMessage);
      } catch {
        // The port may already be unusable this late in teardown.
      }
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.clearInterval(pingTimer);
      window.removeEventListener("pagehide", handlePageHide);
      handlePageHide();
      releaseLocalAudio();
      port.onmessage = null;
      port.close();
      portRef.current = null;
    };
  }, [releaseLocalAudio, tabId]);

  // ── Recording ───────────────────────────────────────────────────────────

  const start = useCallback(async () => {
    if (portRef.current === null) {
      return;
    }

    const granted = await new Promise<{ granted: boolean; reason?: string }>(
      (resolve) => {
        producerGrantRef.current = (granted, reason) => resolve({ granted, reason });
        send({ type: "claim-producer", tabId });
      },
    );

    if (!granted.granted) {
      // The hub already reflects "connecting"/"streaming" from whichever tab
      // holds the mic, so nothing else needs to change here — just surface
      // why this tab's own click did not do anything.
      setLocalError(granted.reason ?? "เริ่มถอดเสียงไม่สำเร็จ");
      return;
    }

    try {
      const selectedDeviceId = deviceIdRef.current;
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
        },
      });
      mediaStreamRef.current = mediaStream;

      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      await context.audioWorklet.addModule("/worklets/pcm-recorder.js");

      // How many samples make up one chunk, at the fixed 16 kHz the worklet
      // always records at — see `ASSEMBLYAI_CHUNK_MS` / `audioChunkMs` in
      // `src/lib/caption.ts`.
      const chunkSamples = Math.round((audioChunkMsRef.current / 1000) * SAMPLE_RATE);
      const worklet = new AudioWorkletNode(context, "pcm-recorder", {
        processorOptions: { chunkSamples },
      });
      workletRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent<WorkletChunk>) => {
        // Transferred rather than copied — this fires ten times a second for
        // as long as the tab records.
        send(
          { type: "pcm", tabId, buffer: event.data.pcm },
          [event.data.pcm],
        );
        // Speech rarely exceeds ~0.25 RMS, so scale up to fill the meter —
        // same factor the combined app's level meter uses.
        send({
          type: "level",
          tabId,
          value: Math.min(1, event.data.level * 4),
        });
      };

      context.createMediaStreamSource(mediaStream).connect(worklet);
      // A worklet only runs while it is part of the rendering graph, so route
      // it to the destination through a muted gain node instead of the
      // speakers.
      const muted = context.createGain();
      muted.gain.value = 0;
      worklet.connect(muted).connect(context.destination);

      const { speechModel, languageCodes, languageDetection } = profileRef.current;
      send({
        type: "begin-stream",
        tabId,
        profile: { speechModel, languageCodes, languageDetection },
      });
    } catch (cause) {
      releaseLocalAudio();
      send({ type: "request-stop", tabId });
      setLocalError(describeStartError(cause));
    }
  }, [releaseLocalAudio, send, setLocalError, tabId]);

  const stop = useCallback(() => {
    send({ type: "request-stop", tabId });
  }, [send, tabId]);

  const clear = useCallback(() => {
    send({ type: "clear", tabId });
  }, [send, tabId]);

  const swapSlot = useCallback(() => {
    send({ type: "swap-slot", tabId });
  }, [send, tabId]);

  const transcript = useMemo(
    () => state.turns.map((turn) => turn.text).join(" "),
    [state.turns],
  );

  return {
    status: state.status,
    turns: state.turns,
    transcript,
    partial: state.partial,
    // The hub's own error (a real problem with the shared session) takes
    // priority; the local one only ever fires while nothing shared exists yet.
    error: state.error ?? localError,
    translationText: state.translation.text,
    translationStatus: state.translation.status,
    translationError: state.translation.error,
    elapsedMs: state.elapsedMs,
    levelRef,
    isProducer: state.producerId === tabId,
    activeSlot: state.activeSlot,
    slotCount: state.slotCount,
    start: () => void start(),
    stop,
    clear,
    swapSlot,
    hubUnsupported,
  };
}
