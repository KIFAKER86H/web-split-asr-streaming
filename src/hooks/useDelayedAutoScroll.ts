"use client";

import { useCallback, useEffect, useRef } from "react";

import type { ScrollMotion } from "@/lib/caption";

/** Natural frequency of the spring, in rad/s. Higher settles faster. */
const SPRING_OMEGA = 7;

/** Clamps the step after a dropped frame or a backgrounded tab. */
const MAX_STEP_SECONDS = 0.05;

/**
 * Speed ceiling, px/s. A spring's peak speed grows with the distance it has to
 * cover, so a long catch-up would blur past unreadably; capping it turns those
 * into a steady glide. Short hops never reach this, so they are unaffected.
 */
const MAX_VELOCITY = 900;

/**
 * Speed used under reduced motion, px/s. Constant rather than sprung: no
 * acceleration, no settle curve, nothing that reads as bouncy — but still a
 * travel rather than a teleport, because a sudden jump of the whole viewport is
 * precisely what motion sensitivity reacts badly to.
 */
const REDUCED_VELOCITY = 400;

/** Stops the loop once the remainder is too small to see, instead of crawling. */
const SETTLE_PX = 1;
const SETTLE_VELOCITY = 8;

interface Options {
  /** Changes whenever the content changes. */
  signal: string;
  /** How long after the first change the view starts following. */
  delayMs?: number;
  motion?: ScrollMotion;
}

function prefersReducedMotion(motion: ScrollMotion): boolean {
  if (motion !== "auto") {
    return motion === "reduced";
  }

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Glides a scroll container toward its newest line.
 *
 * The motion is a critically damped spring driven from `requestAnimationFrame`
 * rather than `scrollTo({ behavior: "smooth" })`. Two reasons: the native
 * behaviour restarts from scratch every time it is called, so captions landing
 * back to back make it stutter and jump; and its speed is fixed by the browser,
 * which on a long jump reads as a teleport. A spring starts from a standstill,
 * accelerates, and settles without overshoot — and because the target is read
 * again on every frame, text arriving mid-glide simply moves the destination
 * and the motion continues uninterrupted.
 *
 * The container is not user-scrollable (`overflow: hidden`), so there is no
 * logic for pausing while someone reads further up: the transcript only ever
 * runs forward.
 */
export function useDelayedAutoScroll<T extends HTMLElement>({
  signal,
  delayMs = 700,
  motion = "auto",
}: Options) {
  const ref = useRef<T | null>(null);
  const frameRef = useRef(0);
  const velocityRef = useRef(0);
  const lastFrameRef = useRef(0);
  const timerRef = useRef(0);

  const glide = useCallback(() => {
    // Already gliding — the running loop will pick up the new target itself.
    if (frameRef.current) {
      return;
    }

    const element = ref.current;
    if (!element) {
      return;
    }

    const reduced = prefersReducedMotion(motion);
    lastFrameRef.current = performance.now();

    const step = (now: number) => {
      const seconds = Math.min(
        (now - lastFrameRef.current) / 1000,
        MAX_STEP_SECONDS,
      );
      lastFrameRef.current = now;

      const target = element.scrollHeight - element.clientHeight;
      const offset = element.scrollTop - target;
      const velocity = velocityRef.current;

      if (Math.abs(offset) < SETTLE_PX && Math.abs(velocity) < SETTLE_VELOCITY) {
        element.scrollTop = target;
        velocityRef.current = 0;
        frameRef.current = 0;
        return;
      }

      if (reduced) {
        const travel = Math.min(Math.abs(offset), REDUCED_VELOCITY * seconds);
        element.scrollTop += offset < 0 ? travel : -travel;
        velocityRef.current = 0;
      } else {
        const acceleration =
          -SPRING_OMEGA * SPRING_OMEGA * offset - 2 * SPRING_OMEGA * velocity;
        const next = velocity + acceleration * seconds;

        velocityRef.current = Math.max(
          -MAX_VELOCITY,
          Math.min(MAX_VELOCITY, next),
        );
        element.scrollTop += velocityRef.current * seconds;
      }

      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
  }, [motion]);

  /**
   * Throttled, not debounced.
   *
   * The delay used to restart on every change, which was harmless while only
   * finished sentences arrived — they land seconds apart. Interim results
   * arrive several times a second, and a restarting timer would never elapse:
   * the view would sit frozen for as long as someone kept talking and only
   * catch up once they stopped. Scheduling the glide on the *first* change and
   * letting it run means the delay is a lead-in, not a gate.
   */
  useEffect(() => {
    if (timerRef.current) {
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      glide();
    }, delayMs);
  }, [signal, delayMs, glide]);

  // Only unmount stops a glide in progress — cancelling it whenever the signal
  // changes is what would make the motion stutter.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      velocityRef.current = 0;
    },
    [],
  );

  return ref;
}
