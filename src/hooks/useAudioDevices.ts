"use client";

import { useCallback, useSyncExternalStore } from "react";

export interface AudioDevice {
  deviceId: string;
  label: string;
}

export interface UseAudioDevicesResult {
  devices: AudioDevice[];
  /** Re-enumerate — worth calling again once a recording has started. */
  refresh: () => void;
}

/**
 * The device list is external state shared by every consumer, so it lives in a
 * module-level store read through `useSyncExternalStore`. Enumeration is async
 * while a store snapshot must be synchronous, hence the cache: the browser's
 * `devicechange` event refreshes it, and subscribers are notified only when the
 * contents actually differ, which keeps the snapshot reference stable.
 */
const EMPTY: AudioDevice[] = [];

let cache: AudioDevice[] = EMPTY;
let listening = false;
/** Whether the last enumeration came back with real product names. */
let labelsKnown = false;
let revealAttempted = false;
const listeners = new Set<() => void>();

function isSameList(a: AudioDevice[], b: AudioDevice[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (device, index) =>
        device.deviceId === b[index].deviceId && device.label === b[index].label,
    )
  );
}

async function refreshCache(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  let all: MediaDeviceInfo[];
  try {
    all = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }

  const inputs = all.filter((device) => device.kind === "audioinput");
  labelsKnown = inputs.length > 0 && inputs.every((device) => device.label !== "");

  const next = inputs.map((device, index) => ({
    deviceId: device.deviceId,
    label: device.label || `ไมโครโฟน ${index + 1}`,
  }));

  if (isSameList(cache, next)) {
    return;
  }

  cache = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Turns "ไมโครโฟน 1" into the actual product name.
 *
 * `enumerateDevices` returns blank labels until the page has held a microphone
 * stream at least once — a fingerprinting guard, and the reason the picker can
 * only offer placeholders on a cold start. Holding a stream for a moment lifts
 * it. Done once, and only while the names are still unknown, so a run that
 * already has permission never touches the microphone just to read a list.
 */
async function revealLabels(): Promise<void> {
  if (labelsKnown || revealAttempted || !navigator.mediaDevices?.getUserMedia) {
    return;
  }

  revealAttempted = true;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Refused, or nothing plugged in — the placeholders stand, and the real
    // names will appear after the first recording instead.
    return;
  }

  stream.getTracks().forEach((track) => track.stop());
  await refreshCache();
}

const handleDeviceChange = () => void refreshCache();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (!listening) {
    listening = true;
    navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange);
  }

  void refreshCache().then(revealLabels);

  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => cache;
const getServerSnapshot = () => EMPTY;

/** Lists the available microphones and keeps the list in step with the hardware. */
export function useAudioDevices(): UseAudioDevicesResult {
  const devices = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const refresh = useCallback(() => void refreshCache(), []);

  return { devices, refresh };
}
