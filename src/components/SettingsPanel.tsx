"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { DeviceListbox, type ListboxOption } from "@/components/DeviceListbox";
import { LevelMeter } from "@/components/LevelMeter";
import { CopyIcon, MicIcon, StopIcon, TrashIcon } from "@/components/icons";
import type {
  ApiSlot,
  HubStreamStatus,
  TranslationStatus,
} from "@/hooks/useCaptionHub";
import { useCaptionSettings } from "@/hooks/useCaptionSettings";
import {
  BOTTOM_GAP_RANGE,
  FONT_CHOICES,
  FONT_SCALE_RANGE,
  LINE_HEIGHT_RANGE,
  buildFontSize,
  currentFontScale,
  currentLineHeightRatio,
  readOverrides,
  resolveFontPx,
  setOverrides,
  type DisplayOverrides,
} from "@/lib/display";
import { formatDuration } from "@/lib/format";
import type { TabMode } from "@/lib/tab-mode";

const GHOST_BUTTON =
  "inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-white/60";

const SLIDER =
  "h-1 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-accent";

interface PanelProps {
  onClose: () => void;

  mode: TabMode;
  onModeChange: (mode: TabMode) => void;
  translationStatus: TranslationStatus;

  devices: ListboxOption[];
  deviceId: string;
  onDeviceChange: (value: string) => void;

  status: HubStreamStatus;
  isProducer: boolean;
  onToggleStream: () => void;
  elapsedMs: number;
  levelRef: RefObject<number>;

  /** Which API set transcription and translation currently read from, and
   *  how many are actually configured — the swap row hides itself unless
   *  this is `2`. */
  activeSlot: ApiSlot;
  slotCount: ApiSlot;
  onSwapSlot: () => void;
  /** The rebindable key for `onSwapSlot` — `F3` unless the operator changed it. */
  swapSlotKey: string;
  /** True while the next keydown should be captured as the new binding
   *  instead of doing whatever it normally does — see `CaptionStage`. */
  capturingHotkey: boolean;
  onStartCaptureHotkey: () => void;

  /** Whatever this tab currently shows — the transcript or the translation. */
  displayText: string;
  copied: boolean;
  onCopy: () => void;
  onClear: () => void;

  /** Resolved from the store by the stage, so both agree on one value. */
  showPartial: boolean;
}

/** A labelled on/off control — `role="switch"` states it for screen readers. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        checked
          ? "border-accent/40 bg-accent/80"
          : "border-white/15 bg-white/10 hover:border-white/30"
      }`}
    >
      <span
        className={`ml-0.5 size-4.5 rounded-full transition-transform ${
          checked ? "translate-x-5 bg-zinc-950" : "translate-x-0 bg-white/60"
        }`}
      />
    </button>
  );
}

/** Two mutually exclusive buttons standing in for a radio group. */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full border border-white/10 bg-white/5 p-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-accent text-zinc-950"
                : "text-white/60 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-white/70">
          {label}
        </span>
        {hint && <span className="text-[11px] text-white/35">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Everything that is not the caption itself.
 *
 * Mounted only while the panel is open, which is what lets the sliders read
 * `localStorage` from a `useState` initialiser: there is no server-rendered
 * markup to disagree with, and no effect that would set state a frame later.
 */
function Panel({
  onClose,
  mode,
  onModeChange,
  translationStatus,
  devices,
  deviceId,
  onDeviceChange,
  status,
  isProducer,
  onToggleStream,
  elapsedMs,
  levelRef,
  activeSlot,
  slotCount,
  onSwapSlot,
  swapSlotKey,
  capturingHotkey,
  onStartCaptureHotkey,
  displayText,
  copied,
  onCopy,
  onClear,
  showPartial,
}: PanelProps) {
  const defaults = useCaptionSettings();
  const titleId = useId();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  // Measured once on open, so the sliders start where the caption actually is
  // rather than at an arbitrary midpoint — the `.env` default may be a
  // `clamp()`, which no amount of string parsing turns into a number.
  const [settings, setSettings] = useState(() => {
    const stored = readOverrides();
    return {
      overrides: stored,
      fontScale:
        stored.fontScale ?? currentFontScale(defaults.typography.fontSize),
      lineHeight: stored.lineHeight ?? currentLineHeightRatio(),
      bottomGap: stored.bottomGap ?? defaults.bottomGap,
    };
  });

  const { overrides, fontScale, lineHeight, bottomGap } = settings;

  // What the chosen scale actually renders as on this screen. The slider's own
  // number is quoted at a reference width, which means nothing to someone
  // standing in front of a projector.
  const renderedPx = Math.round(resolveFontPx(buildFontSize(fontScale)));
  const streaming = status === "streaming";

  // The merge source has to survive between renders: a slider fires changes
  // faster than React commits them, and merging from the rendered `overrides`
  // would let a second change overwrite the first with a stale copy.
  const overridesRef = useRef(settings.overrides);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    panelRef.current?.focus();

    return () => {
      // Sending focus back to whatever opened the panel keeps the tab order
      // sane; the display itself has nothing focusable, so it lands on body.
      if (restoreFocusRef.current instanceof HTMLElement) {
        restoreFocusRef.current.focus();
      }
    };
  }, []);

  /** Merges one setting through to the DOM and to storage in a single step. */
  const update = useCallback(
    (
      patch: DisplayOverrides,
      measured?: Partial<Omit<typeof settings, "overrides">>,
    ) => {
      const next = { ...overridesRef.current, ...patch };
      overridesRef.current = next;

      setOverrides(next);
      setSettings((previous) => ({ ...previous, ...measured, overrides: next }));
    },
    [],
  );

  const reset = useCallback(() => {
    overridesRef.current = {};

    setOverrides({});
    setSettings({
      overrides: {},
      fontScale: currentFontScale(defaults.typography.fontSize),
      lineHeight: currentLineHeightRatio(),
      bottomGap: defaults.bottomGap,
    });
  }, [defaults]);

  const fontValue = overrides.fontFamily ?? defaults.typography.fontFamily;
  const knownFont = FONT_CHOICES.some((choice) => choice.value === fontValue);
  // Each row previews itself, so the list reads as a specimen sheet.
  const bundledFonts: ListboxOption[] = FONT_CHOICES.map(({ value, label }) => ({
    value,
    label,
    fontFamily: value,
  }));
  const fontOptions: ListboxOption[] = knownFont
    ? bundledFonts
    : [
        { value: fontValue, label: "ค่าจาก .env", fontFamily: fontValue },
        ...bundledFonts,
      ];

  const overridden = Object.keys(overrides).length > 0;
  const busy = status !== "idle";
  const recordingElsewhere = busy && !isProducer;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="my-auto w-full max-w-lg rounded-3xl border border-white/10 bg-zinc-950/95 p-6 shadow-[0_0_120px_-40px_var(--caption-halo)] outline-none"
      >
        <div className="mb-5 flex items-baseline justify-between gap-3">
          <h2 id={titleId} className="text-sm font-medium tracking-wide text-white">
            ตั้งค่า
          </h2>
          <span className="text-[11px] text-white/35">
            F2 ปิด · Esc ปิด · F4 เริ่ม/หยุด
          </span>
        </div>

        <div className="flex flex-col gap-6">
          {/*
            First, because it decides what the rest of this tab is even for.
            The choice belongs to this tab alone — see `src/lib/tab-mode.ts`.
          */}
          <Row
            label="แท็บนี้แสดง"
            hint={
              mode === "translate" && translationStatus === "off"
                ? "ยังไม่ได้ตั้งค่าโมเดลแปล"
                : "ค่านี้ไม่ใช้ร่วมกับแท็บอื่น"
            }
          >
            <Segmented
              value={mode}
              onChange={onModeChange}
              label="โหมดของแท็บนี้"
              options={[
                { value: "transcribe", label: "ถอดเสียง" },
                { value: "translate", label: "แปลภาษา" },
              ]}
            />
          </Row>

          {/*
            Recording next: it is the only control anyone reaches for
            mid-session, and it drives the *shared* session every tab reads
            from, transcribe and translate alike.
          */}
          <Row
            label="การถอดเสียง"
            hint={recordingElsewhere ? "กำลังอัดจากอีกแท็บ" : undefined}
          >
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onToggleStream}
                disabled={status === "connecting"}
                aria-label={streaming ? "หยุดถอดเสียง" : "เริ่มถอดเสียง"}
                // Near-black on the accent: the pink is light enough that white
                // text would sit at 2.3:1, while black reaches 9:1.
                className={`inline-flex size-12 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  streaming
                    ? "bg-red-600 text-white hover:bg-red-500"
                    : "bg-accent text-zinc-950 hover:bg-accent-bright"
                }`}
              >
                {streaming ? <StopIcon /> : <MicIcon />}
              </button>

              <span className="font-mono text-sm text-white/50 tabular-nums">
                {formatDuration(elapsedMs)}
              </span>

              {status === "connecting" ? (
                <span className="text-xs text-white/40">กำลังเชื่อมต่อ…</span>
              ) : (
                <LevelMeter levelRef={levelRef} active={streaming} />
              )}
            </div>
          </Row>

          {/*
            Only shown once a second API set is actually configured — with
            nothing to switch to, this row would just be clutter (and the
            hotkey already does nothing in that case; see `transcribeSlotCount`
            in `src/lib/server/config.ts`).
          */}
          {slotCount === 2 && (
            <Row
              label="ชุด API"
              hint="ถอดเสียงและแปลสลับไปพร้อมกัน ไม่มีรอยต่อขณะกำลังอัด"
            >
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  value={activeSlot}
                  onChange={(value) => {
                    if (value !== activeSlot) {
                      onSwapSlot();
                    }
                  }}
                  label="ชุด API ที่ใช้อยู่"
                  options={[
                    { value: 1, label: "ชุด 1" },
                    { value: 2, label: "ชุด 2" },
                  ]}
                />
                <button
                  type="button"
                  onClick={onStartCaptureHotkey}
                  className={GHOST_BUTTON}
                >
                  {capturingHotkey ? "กดปุ่มที่ต้องการ…" : `คีย์ลัด: ${swapSlotKey}`}
                </button>
              </div>
            </Row>
          )}

          <Row
            label="ไมโครโฟน"
            hint={busy ? "เปลี่ยนไม่ได้ขณะถอดเสียง" : undefined}
          >
            <DeviceListbox
              options={devices}
              value={deviceId}
              onChange={onDeviceChange}
              disabled={busy}
              label="เลือกไมโครโฟน"
              emptyLabel="ยังไม่พบไมโครโฟน"
            />
          </Row>

          {/*
            Only means anything on the transcribe tab — a translated turn is
            never partial, it either has arrived or it has not.
          */}
          {mode === "transcribe" && (
            <Row
              label="แสดงข้อความระหว่างพูด"
              hint={showPartial ? "ข้อความจาง = ยังไม่นิ่ง" : "รอจบประโยคก่อน"}
            >
              <div className="flex items-center gap-3">
                <Toggle
                  checked={showPartial}
                  onChange={(next) => update({ showPartial: next })}
                  label="แสดงข้อความระหว่างพูด"
                />
                <span className="text-[11px] text-white/40">
                  เห็นเร็วขึ้น แต่ตัวหนังสือจะแก้ตัวเองระหว่างอ่าน
                </span>
              </div>
            </Row>
          )}

          <Row label="ฟอนต์" hint="สองตัวล่างไม่มีตัวอักษรไทย">
            <DeviceListbox
              options={fontOptions}
              value={fontValue}
              onChange={(value) => update({ fontFamily: value })}
              label="เลือกฟอนต์ของข้อความ"
              emptyLabel="—"
            />
          </Row>

          <Row
            label="ขนาดตัวอักษร"
            hint={`~${renderedPx}px ที่จอนี้ · สเกลตามจอ`}
          >
            <input
              type="range"
              className={SLIDER}
              min={FONT_SCALE_RANGE.min}
              max={FONT_SCALE_RANGE.max}
              step={FONT_SCALE_RANGE.step}
              value={fontScale}
              aria-label="ขนาดตัวอักษรของข้อความ"
              onChange={(event) => {
                const next = Number(event.target.value);
                update(
                  { fontSize: buildFontSize(next), fontScale: next },
                  { fontScale: next },
                );
              }}
            />
          </Row>

          {/*
            Thai stacks marks above and below the letters, so this matters more
            here than it would on a Latin-only display.
          */}
          <Row label="ระยะห่างบรรทัด" hint={`${lineHeight.toFixed(2)} เท่าของตัวอักษร`}>
            <input
              type="range"
              className={SLIDER}
              min={LINE_HEIGHT_RANGE.min}
              max={LINE_HEIGHT_RANGE.max}
              step={LINE_HEIGHT_RANGE.step}
              value={lineHeight}
              aria-label="ระยะห่างระหว่างบรรทัด"
              onChange={(event) => {
                const next = Number(event.target.value);
                update({ lineHeight: next }, { lineHeight: next });
              }}
            />
          </Row>

          {/*
            Lifts the text off the bottom edge — for a screen that shares the
            frame with something else sitting below it (a lower-third, a
            taskbar, another OBS source).
          */}
          <Row
            label="ยกข้อความจากขอบล่าง"
            hint={bottomGap === 0 ? "ชิดขอบเหมือนเดิม" : `${bottomGap}vh จากขอบจริง`}
          >
            <input
              type="range"
              className={SLIDER}
              min={BOTTOM_GAP_RANGE.min}
              max={BOTTOM_GAP_RANGE.max}
              step={BOTTOM_GAP_RANGE.step}
              value={bottomGap}
              aria-label="ยกข้อความจากขอบล่างของจอ"
              onChange={(event) => {
                const next = Number(event.target.value);
                update({ bottomGap: next }, { bottomGap: next });
              }}
            />
          </Row>

          <Row label={mode === "transcribe" ? "ข้อความที่ถอดได้" : "ข้อความที่แปลได้"}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                disabled={!displayText}
                className={GHOST_BUTTON}
              >
                <CopyIcon />
                {copied ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>

              <button
                type="button"
                onClick={onClear}
                disabled={!displayText && elapsedMs === 0}
                title="ล้างข้อความในทุกแท็บ — ใช้ร่วมกันทั้งเซสชัน"
                className={GHOST_BUTTON}
              >
                <TrashIcon />
                ล้างทุกแท็บ
              </button>

              <button
                type="button"
                onClick={reset}
                disabled={!overridden}
                className={`${GHOST_BUTTON} ml-auto`}
              >
                คืนค่าจาก .env
              </button>
            </div>
          </Row>
        </div>
      </div>
    </div>
  );
}

/**
 * The settings overlay, kept out of the tree entirely while it is closed.
 *
 * Unmounting rather than hiding is what makes `Panel` able to measure the live
 * caption on the way in — and it means the display screen carries no dialog
 * markup at all when nobody is looking at the settings.
 */
export function SettingsPanel({
  open,
  ...props
}: PanelProps & { open: boolean }) {
  return open ? <Panel {...props} /> : null;
}
