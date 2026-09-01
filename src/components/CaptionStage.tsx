"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { CaptionPane } from "@/components/CaptionPane";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useAudioDevices } from "@/hooks/useAudioDevices";
import { useCaptionHub } from "@/hooks/useCaptionHub";
import { useCaptionSettings } from "@/hooks/useCaptionSettings";
import { useSwapSlotKey } from "@/hooks/useSwapSlotKey";
import { useTabMode } from "@/hooks/useTabMode";
import { STREAM_PROFILES } from "@/lib/aai";
import {
  overridesSnapshot,
  serverOverridesSnapshot,
  subscribeOverrides,
} from "@/lib/display";

/** Language steering is server-side config; the settings panel picks the microphone. */
const PROFILE = STREAM_PROFILES[0];

/** Opens the settings panel — also where a tab's transcribe/translate mode lives. */
const SETTINGS_KEY = "F2";
/** Starts and stops the shared recording, from whichever tab presses it. */
const STREAM_KEY = "F4";
/** Never assignable as the slot-swap key — each already means something else. */
const RESERVED_HOTKEYS = [SETTINGS_KEY, STREAM_KEY, "Escape"];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[11px] text-white/45">
      {children}
    </kbd>
  );
}

export function CaptionStage() {
  const defaults = useCaptionSettings();
  const { scrollMotion } = defaults;
  const { mode, setMode } = useTabMode();

  // The viewer's saved choice wins over the `.env` default. Reading it through
  // a store keeps the first render matching the server's markup — and there is
  // no interim text on screen at that point anyway, so nothing can flash.
  const overrides = useSyncExternalStore(
    subscribeOverrides,
    overridesSnapshot,
    serverOverridesSnapshot,
  );
  const showPartial = overrides.showPartial ?? defaults.showPartial;

  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { swapSlotKey, setSwapSlotKey } = useSwapSlotKey();
  /** True while the next keydown should be captured as the new swap-slot
   *  binding instead of doing whatever it normally does. */
  const [capturingHotkey, setCapturingHotkey] = useState(false);

  // The microphone lives in its own shared store rather than in this
  // component's state — it is one of the settings every tab on this origin
  // agrees on, so the tab that ends up recording uses the one that was picked,
  // whichever tab it was picked in. See `src/lib/audio-device.ts`.
  const {
    devices,
    deviceId,
    setDeviceId,
    refresh: refreshDevices,
  } = useAudioDevices();

  const {
    status,
    transcript,
    partial,
    error,
    translationText,
    translationStatus,
    translationError,
    elapsedMs,
    levelRef,
    isProducer,
    activeSlot,
    slotCount,
    start,
    stop,
    clear,
    swapSlot,
    hubUnsupported,
  } = useCaptionHub({ profile: PROFILE, deviceId, audioChunkMs: defaults.audioChunkMs });

  const streaming = status === "streaming";

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Device labels stay blank until the page has held a stream once, so re-read
  // the list as soon as recording begins.
  useEffect(() => {
    if (status === "streaming") {
      refreshDevices();
    }
  }, [status, refreshDevices]);

  const toggleStream = useCallback(() => {
    if (streaming || status === "connecting") {
      stop();
    } else {
      start();
    }
  }, [start, status, stop, streaming]);

  const startCaptureHotkey = useCallback(() => {
    setCapturingHotkey(true);
  }, []);

  /**
   * Function keys rather than letters or Space: the panel contains a listbox
   * and two sliders that already answer to those, and the display is meant to
   * be driven without looking away from it.
   *
   * While `capturingHotkey` is true, this same listener does something
   * different: the next plain keydown becomes the new slot-swap binding
   * instead of triggering whatever it normally would. That is deliberately
   * folded into the one listener the app already has rather than given a
   * second one in `SettingsPanel` — with only one `keydown` handler in the
   * whole app, there is no listener-ordering question to get wrong about
   * which one sees a key first.
   */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Alt+F4 and the browser's own chords stay the browser's business —
      // also true while capturing: a rebound key is never a modifier combo,
      // the same restriction F2 and F4 already live under.
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
        return;
      }

      if (capturingHotkey) {
        event.preventDefault();
        setCapturingHotkey(false);
        // Escape cancels without changing anything; a key already spoken
        // for is silently rejected — the button reverting to the old
        // binding is feedback enough that nothing was saved.
        if (event.key !== "Escape" && !RESERVED_HOTKEYS.includes(event.key)) {
          setSwapSlotKey(event.key);
        }
        return;
      }

      switch (event.key) {
        case SETTINGS_KEY:
          event.preventDefault();
          setSettingsOpen((open) => !open);
          break;
        case STREAM_KEY:
          event.preventDefault();
          toggleStream();
          break;
        case swapSlotKey:
          event.preventDefault();
          swapSlot();
          break;
        case "Escape":
          setSettingsOpen(false);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [capturingHotkey, setSwapSlotKey, swapSlot, swapSlotKey, toggleStream]);

  const handleCopy = useCallback(async () => {
    const text = mode === "transcribe" ? transcript : translationText;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked; nothing useful to recover here.
    }
  }, [mode, transcript, translationText]);

  const displayText = mode === "transcribe" ? transcript : translationText;
  const modeLabel = mode === "transcribe" ? "ถอดเสียง" : "แปลภาษา";
  const brandLabel = mode === "transcribe" ? "Live Transcribe" : "Live Translate";
  const bannerError =
    error ?? (mode === "translate" && translationError
      ? `แปลภาษาไม่สำเร็จ: ${translationError}`
      : null);

  return (
    // `h-dvh` rather than `min-h-dvh`: the caption fills exactly one screen and
    // never scrolls the page, on a phone with a retracting toolbar included.
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(65%_45%_at_50%_0%,var(--accent-glow),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_60%_at_50%_50%,var(--caption-ambient),transparent_75%)]" />

      {/*
        A solid band across the top, not a floating badge. The caption scrolls
        underneath it, and because the band is opaque the outgoing line vanishes
        behind it instead of hanging over the screen as a ghost.
        Height comes from `--caption-topbar` in `globals.css`, which the pane's
        top padding is derived from.
      */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[var(--caption-topbar)] items-center justify-between border-b border-white/10 bg-black px-[clamp(1.25rem,5vw,7rem)]">
        <span className="inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-white/5 px-3.5 py-2">
          {/*
            The logo ships as light artwork on transparency, cropped tight to
            its own content (1040×338 — see `public/assets/logo.png`, and
            keep `width`/`height` here matching that crop if it's ever
            replaced, or the aspect ratio Next.js reserves for layout will be
            wrong). `brightness-0` flattens every opaque pixel to black and
            `invert` lifts it to white, leaving the alpha channel — and so the
            letterforms — untouched, regardless of the source colour.
          */}
          <Image
            src="/assets/logo.png"
            alt="NECTEC"
            width={1040}
            height={338}
            priority
            className="h-8 w-auto brightness-0 invert"
          />
          <span className="text-sm font-medium tracking-wide text-white">
            {brandLabel}
          </span>
        </span>

        {/*
          Which pane this tab is showing, at a glance — useful when several
          tabs (or several OBS browser sources pointed at this same URL) are
          open side by side and only one of them is in view at a time.
        */}
        {/* <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs tracking-wide text-white/50">
          {modeLabel}
        </span> */}
      </header>

      <CaptionPane
        text={mode === "transcribe" ? transcript : translationText}
        pending={mode === "transcribe" && showPartial ? partial : ""}
        placeholder={
          mode === "translate" && translationStatus === "off" ? (
            "ยังไม่ได้ตั้งค่าโมเดลแปล — เพิ่ม TEXT_BASE_URL และ TEXT_MODEL_NAME ใน .env"
          ) : streaming ? (
            mode === "transcribe" ? (
              "กำลังฟัง… เริ่มพูดได้เลย"
            ) : (
              "รอคำแปล…"
            )
          ) : (
            <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              กด <Kbd>{STREAM_KEY}</Kbd> เพื่อเริ่มถอดเสียง · <Kbd>{SETTINGS_KEY}</Kbd>{" "}
              เปิดการตั้งค่า
            </span>
          )
        }
        scrollMotion={scrollMotion}
        label={mode === "transcribe" ? "ข้อความจากการถอดเสียง" : "คำแปลภาษาอังกฤษ"}
      />

      {/*
        Floated, and errors first: a failing microphone or a failing translate
        endpoint matters more than any animation, and an error must never
        resize the caption underneath a reader mid-sentence.
      */}
      {(bannerError || hubUnsupported) && (
        <p className="absolute inset-x-[clamp(1.25rem,5vw,7rem)] bottom-[clamp(1rem,3vh,2.5rem)] z-10 rounded-xl border border-red-500/25 bg-red-950/80 px-4 py-2.5 text-center text-sm text-red-300 backdrop-blur">
          {hubUnsupported
            ? "เบราว์เซอร์นี้ไม่รองรับ SharedWorker — ลองเปิดด้วย Chrome หรือ Firefox"
            : bannerError}
        </p>
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mode={mode}
        onModeChange={setMode}
        translationStatus={translationStatus}
        devices={devices.map((device) => ({
          value: device.deviceId,
          label: device.label,
        }))}
        deviceId={deviceId}
        onDeviceChange={setDeviceId}
        status={status}
        isProducer={isProducer}
        onToggleStream={toggleStream}
        elapsedMs={elapsedMs}
        levelRef={levelRef}
        activeSlot={activeSlot}
        slotCount={slotCount}
        onSwapSlot={swapSlot}
        swapSlotKey={swapSlotKey}
        capturingHotkey={capturingHotkey}
        onStartCaptureHotkey={startCaptureHotkey}
        displayText={displayText}
        copied={copied}
        onCopy={() => void handleCopy()}
        onClear={clear}
        showPartial={showPartial}
      />
    </div>
  );
}
