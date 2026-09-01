/**
 * The caption hub — a `SharedWorker` shared by every tab this origin has open.
 *
 * It owns the one thing that must exist exactly once no matter how many tabs
 * are showing captions: the AssemblyAI WebSocket session and the translation
 * queue behind it. A tab never talks to `/api/token` or `/api/translate`
 * itself — it asks the hub, and the hub answers every connected tab at once.
 * That is what lets a transcribe tab and a translate tab sit on two different
 * monitors (or two different OBS browser sources) pointed at the same
 * `http://.../` URL and stay in lock-step without either one waiting on the
 * other to render first.
 *
 * Audio capture cannot happen here — a worker has no `getUserMedia` — so it
 * stays on the main thread of whichever tab starts a recording (the
 * "producer"). That tab streams raw PCM up to the hub over its `MessagePort`
 * and the hub is the one that owns the socket and sends the bytes on. See
 * `src/hooks/useCaptionHub.ts` for that half.
 *
 * This file is plain JavaScript rather than TypeScript on purpose: Next.js has
 * no built-in pipeline for compiling a `SharedWorker` entry point (unlike a
 * module a page imports), and this runs in a global scope with no DOM anyway,
 * so there is nothing a bundler would buy here — the same reasoning that kept
 * `public/worklets/pcm-recorder.js` plain JS. The message shapes are typed on
 * the tab side in `src/lib/hub-protocol.ts`; **the two must be kept in sync
 * by hand.**
 *
 * ── Why the heartbeat, not just "port closed" ──────────────────────────────
 * Neither Chrome nor Firefox tells a `SharedWorker` when a tab holding one of
 * its ports goes away — there is no `port.onclose`. A page that navigates or
 * reloads cleanly can say so itself (see `bye` below, sent from `pagehide`,
 * which both browsers fire reliably including through the back/forward
 * cache), but a crashed tab, a killed process, or a browser closed by the OS
 * says nothing. Left unhandled, the hub would believe a producer that no
 * longer exists is still about to send audio, and the session would hang in
 * "streaming" forever. So every tab pings on an interval, and this file
 * prunes any port that has gone quiet for far longer than that.
 * `bye` makes the common case (closing a tab normally) instant; the heartbeat
 * is the backstop for everything else, on both browsers alike.
 *
 * A quiet port is *not* strong evidence of a dead tab, though: a backgrounded
 * or folded-away tab has its timers throttled or frozen by the browser, and
 * says nothing for exactly the same reason a crashed one does. So the prune
 * window is deliberately generous (see `PRUNE_TIMEOUT_MS`) and, more
 * importantly, pruning is *recoverable* — a message arriving on a port the hub
 * has already forgotten re-admits that port instead of being dropped (see
 * `handleMessage`). Without that, a tab pruned while out of sight came back to
 * a hub that ignored it permanently: the UI still rendered and still animated,
 * but no state update ever arrived and no button press ever landed.
 *
 * ── API slots ───────────────────────────────────────────────────────────
 * `.env` can describe a second transcribe + translate API set (the `_B`
 * suffixed variables — see `transcribeSlotCount` in
 * `src/lib/server/config.ts`), and the tab-side hotkey (`F3` by default) asks
 * the hub to move over to it. Both `/api/token` and `/api/translate` take a
 * `?slot=` query string, so the swap itself is nothing more than the hub
 * fetching a new token against a different slot and opening a second socket —
 * see `handleSwapSlot` below for how that stays gap-free while a recording is
 * running.
 */

"use strict";

// ── Constants duplicated from src/lib/aai.ts — keep the two in sync ───────
const DEFAULT_WS_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";
const SAMPLE_RATE = 16_000;

// A healthy tab is expected to ping roughly every 5s — see PING_INTERVAL_MS
// in `src/hooks/useCaptionHub.ts`, the tab-side half of this heartbeat.
/** How often the hub checks for tabs that have stopped pinging. */
const PRUNE_CHECK_MS = 4_000;
/**
 * How long a tab may go quiet before its port is pruned.
 *
 * Generous on purpose. A backgrounded tab — another window in front, the
 * screen locked, a foldable closed, the machine asleep — has its timers
 * throttled hard (Chrome drops hidden tabs to roughly one tick a minute) or
 * frozen outright, so a quiet port is far more often a tab that is merely out
 * of sight than one that has died. An earlier 13s window pruned those tabs
 * within seconds of being folded away, and since a pruned port could never
 * re-register, the tab came back to a UI that rendered fine but whose every
 * button and every state update went nowhere. Pruning is a cleanup pass for
 * genuinely dead tabs (a crash, a killed process), and nothing breaks if it
 * takes a minute to notice one; `bye` still makes the common case instant, and
 * `handleMessage` now re-admits a port that was pruned too eagerly anyway.
 */
const PRUNE_TIMEOUT_MS = 45_000;
/**
 * The same, for the tab currently holding the microphone. Longer still because
 * pruning *this* one ends the recording for everybody, and because a producer
 * that is genuinely alive refreshes its timestamp ten times a second through
 * `pcm` alone — silence this long from a producer really is a dead one.
 */
const PRODUCER_PRUNE_TIMEOUT_MS = 120_000;

/**
 * Longest the outgoing side of a hot slot swap is allowed to linger, waiting
 * for AssemblyAI to flush whatever turn it still had buffered, before the hub
 * hangs up on it regardless. Purely a cleanup bound — nothing user-visible
 * waits on it, since the incoming connection is already live by the time this
 * timer starts.
 */
const SWAP_FLUSH_GRACE_MS = 6_000;

/**
 * Backoff schedule for reconnecting after the live socket drops on its own —
 * a network blip, a server restart, an abnormal closure (WebSocket code
 * `1006`, which carries no reason at all — see the header comment on
 * `describeCloseCode`). Short first, since most of these are a brief hiccup
 * the server is already back from by the time a human would notice; growing
 * afterwards so a genuinely dead server doesn't get hammered. The last entry
 * repeats for as long as `RECONNECT_GIVE_UP_MS` keeps allowing attempts.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
/** Stop retrying and surface the failure after this long of unbroken
 *  attempts — an "auto-reconnect" that never gives up is indistinguishable
 *  from a hang to whoever is staring at "กำลังเชื่อมต่อ…". */
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1_000;

// ── Connected tabs ──────────────────────────────────────────────────────────

/** `MessagePort` → `{ tabId, lastPing }`. */
const ports = new Map();

function broadcast(message) {
  for (const port of ports.keys()) {
    try {
      port.postMessage(message);
    } catch {
      // A port whose tab is mid-teardown can throw; the heartbeat prune will
      // remove it shortly regardless.
    }
  }
}

function broadcastState() {
  broadcast({ type: "state", state });
}

function tellProducer(message) {
  for (const [port, info] of ports) {
    if (info.tabId && info.tabId === state.producerId) {
      try {
        port.postMessage(message);
      } catch {
        // See broadcast() above.
      }
    }
  }
}

// ── Shared state, mirrored to every tab on every change ────────────────────

const state = {
  status: "idle",
  turns: [],
  partial: "",
  error: null,
  translation: { text: "", status: "unknown", error: null },
  elapsedMs: 0,
  producerId: null,
  activeSlot: 1,
  slotCount: 1,
};

// ── AssemblyAI socket ────────────────────────────────────────────────────

/** The connection actually carrying audio right now — every `pcm` message
 *  routes through whichever `WebSocket` sits here, and only a close of *this*
 *  one ends the session. See `connectSlot` and `handleConnectionClosed`. */
let socket = null;
/** True while `socket` is being closed on purpose (a stop, a producer tab
 *  going away, or a failed start) — suppresses the "connection lost" error
 *  `handleConnectionClosed` would otherwise report for a closure nobody needs
 *  explained. Never set for a hot swap's outgoing side — that one is never
 *  `socket` by the time it closes, so it can't trigger that error anyway. */
let closingSocket = false;
/** Hands out a unique id to each connection, for its turns' ids — see
 *  `applyTurn`. Not used for validity checks; see `connectSlot`'s own header
 *  comment for why that guard moved elsewhere. */
let sessionCounter = 0;

/** Which API set is live, and the recognition profile the current recording
 *  started with — reused so a hot swap reconnects with the same language
 *  settings instead of guessing. */
let activeSlot = 1;
let activeProfile = null;
/** `2` once `/api/slots` confirms a second API set is actually configured. */
let slotCount = 1;

/** Pending automatic-reconnect retry, if one is scheduled — see
 *  `scheduleReconnect` and `handleConnectionClosed`. */
let reconnectTimer = null;
let reconnectAttempt = 0;
/** Set on the first attempt of a reconnect run, checked on every later one —
 *  `RECONNECT_GIVE_UP_MS` bounds the whole run, not any single retry. */
let reconnectDeadline = 0;

let elapsedTimer = null;
let elapsedStartedAt = 0;

/**
 * Resumes rather than resets: stopping and starting again *continues* the
 * clock, the same way the combined app's `elapsedRef` survives a stop/start
 * pair and only `clear` zeroes it. A caption operator pausing between
 * segments of a talk wants the total recorded time, not a counter that forgets
 * every time they let go of the mic button.
 */
function startElapsedTimer() {
  stopElapsedTimer();
  elapsedStartedAt = Date.now() - state.elapsedMs;
  elapsedTimer = setInterval(() => {
    state.elapsedMs = Date.now() - elapsedStartedAt;
    broadcastState();
  }, 250);
}

function stopElapsedTimer() {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

/** Builds the handshake URL — mirrors `buildSocketUrl` in `src/lib/aai.ts`. */
function buildSocketUrl(endpoint, token, profile) {
  const url = new URL(endpoint);
  if (token) {
    url.searchParams.set("token", token);
  }
  url.searchParams.set("encoding", "pcm_s16le");
  url.searchParams.set("sample_rate", String(SAMPLE_RATE));
  url.searchParams.set("speech_model", profile.speechModel);

  if (profile.languageCodes && profile.languageCodes.length > 0) {
    url.searchParams.set("language_codes", profile.languageCodes.join(","));
  }
  if (profile.languageDetection) {
    url.searchParams.set("language_detection", "true");
  }

  return url.toString();
}

/** Mirrors `parseServerMessage` in `src/lib/aai.ts`. */
function parseServerMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.type === "string") {
      return parsed;
    }
  } catch {
    // Non-JSON frames are not part of the protocol.
  }
  return null;
}

/** Mirrors `describeCloseCode` in `src/lib/aai.ts`. */
function describeCloseCode(code, reason) {
  if (code === 1000 || code === 1005) {
    return null;
  }
  if (code === 4001 || code === 4003) {
    return "โทเค็นไม่ถูกต้องหรือหมดอายุ — ลองเริ่มใหม่อีกครั้ง";
  }
  if (code === 4008) {
    return "เกินโควตาการใช้งานของบัญชี AssemblyAI";
  }
  return reason
    ? `การเชื่อมต่อถูกปิด (${code}): ${reason}`
    : `การเชื่อมต่อถูกปิด (${code})`;
}

/** Pulls the message out of an error response, whatever shape it came back in. */
async function describeFailure(response, fallback) {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Not JSON — a proxy error page, most likely.
  }
  return `${fallback} (${response.status})`;
}

function describeError(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Opens one connection to a transcribe API slot: requests a token against it,
 * opens the socket, and resolves once the socket actually reaches OPEN (or
 * rejects if either step fails). Deliberately touches nothing but the socket
 * itself — not `socket`, not `state.status`, not the elapsed timer — so the
 * same function serves both a plain start (`handleBeginStream`) and one half
 * of a hot swap (`handleSwapSlot`): the caller alone decides whether, and
 * when, a connection this opens becomes the live one.
 *
 * Turn messages are applied unconditionally as soon as they arrive, whether
 * or not this connection ever becomes (or still is) the live one — a turn is
 * valid transcript the moment AssemblyAI sends it, including the last one or
 * two a hot swap's outgoing side is still waiting on after `socket` has
 * already moved to its replacement. What a connection being "live" gates is
 * narrower: whether *new* audio reaches it, and whether *its* close ends the
 * session — both handled by comparing against `socket` at the point of use
 * (see the `pcm` case in `handleMessage` and `handleConnectionClosed`) rather
 * than by any flag carried here.
 */
function connectSlot(slot, profile) {
  return fetch(`/api/token?slot=${slot}`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await describeFailure(response, "ขอโทเค็นไม่สำเร็จ"));
      }
      return response.json();
    })
    .then(
      (payload) =>
        new Promise((resolve, reject) => {
          const wsEndpoint = payload.wsEndpoint || DEFAULT_WS_ENDPOINT;
          let ws;
          try {
            ws = new WebSocket(buildSocketUrl(wsEndpoint, payload.token ?? null, profile));
          } catch (cause) {
            reject(cause instanceof Error ? cause : new Error(describeError(cause)));
            return;
          }
          ws.binaryType = "arraybuffer";

          const label = ++sessionCounter;
          let settled = false;

          ws.onopen = () => {
            if (settled) {
              return;
            }
            settled = true;
            resolve(ws);
          };

          ws.onerror = () => {
            if (settled) {
              return;
            }
            settled = true;
            reject(new Error("เชื่อมต่อ AssemblyAI ไม่สำเร็จ"));
          };

          ws.onmessage = (event) => {
            if (typeof event.data !== "string") {
              return;
            }
            const message = parseServerMessage(event.data);
            if (!message) {
              return;
            }
            if (message.type === "Turn") {
              applyTurn(message, label);
              return;
            }
            if (message.type === "Termination") {
              ws.close();
            }
          };

          ws.onclose = (event) => handleConnectionClosed(ws, event);
        }),
    );
}

/**
 * Fires for every connection this hub ever opens, live or not — see
 * `connectSlot`'s header comment. Only a close of the connection currently
 * assigned to `socket` ends (or, below, tries to resume) the session; an
 * outgoing hot-swap connection winding down, or one that never made it past
 * the handshake, simply disappears without touching `state` at all.
 */
function handleConnectionClosed(ws, event) {
  if (socket !== ws) {
    return;
  }
  socket = null;

  if (closingSocket) {
    // Asked for — a stop, a producer tab going away, or a failed start.
    // Nothing to reconnect to; finish tearing the session down.
    closingSocket = false;
    activeProfile = null;
    stopElapsedTimer();
    state.status = "idle";
    state.partial = "";
    state.producerId = null;
    broadcastState();
    return;
  }

  const reason = describeCloseCode(event.code, event.reason || "");

  // The producer's mic is presumably still live and still sending PCM into a
  // socket that no longer exists — worth trying to pick the session back up
  // rather than ending it outright. `4008` (quota exceeded) is the one close
  // code retrying can't fix: the account is over its limit regardless of how
  // fresh the token is, so hammering the token endpoint every second would
  // just be noise. Everything else — including `1006`, which is what a
  // plain network blip or an unannounced server restart looks like — gets a
  // real attempt.
  if (state.producerId && activeProfile && event.code !== 4008) {
    // Whatever `reason` says (often nothing at all — see the header comment
    // on `describeCloseCode` for why `1006` never carries one), make clear
    // this isn't the end of the session: a retry is already queued.
    state.error = reason
      ? `${reason} — กำลังเชื่อมต่อใหม่…`
      : "การเชื่อมต่อขาดหาย — กำลังเชื่อมต่อใหม่…";
    state.status = "connecting";
    broadcastState();
    scheduleReconnect();
    return;
  }

  // Ending outright (quota exceeded, or nothing left worth reconnecting
  // for) — the mic would otherwise keep capturing into a session that no
  // longer exists, with nothing in the UI still showing it is live.
  tellProducer({ type: "release-mic" });
  if (reason) {
    state.error = reason;
  }
  activeProfile = null;
  stopElapsedTimer();
  state.status = "idle";
  state.partial = "";
  state.producerId = null;
  broadcastState();
}

function cancelReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
}

/** Queues the next reconnect attempt, or gives up if `RECONNECT_GIVE_UP_MS`
 *  has run out since the *first* attempt in this run. */
function scheduleReconnect() {
  if (reconnectAttempt === 0) {
    reconnectDeadline = Date.now() + RECONNECT_GIVE_UP_MS;
  }

  if (Date.now() > reconnectDeadline) {
    reconnectAttempt = 0;
    tellProducer({ type: "release-mic" });
    state.error = "เชื่อมต่อใหม่ไม่สำเร็จติดต่อกันหลายครั้ง — กด F4 เพื่อเริ่มใหม่อีกครั้ง";
    activeProfile = null;
    state.status = "idle";
    state.producerId = null;
    broadcastState();
    return;
  }

  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void tryReconnect();
  }, delay);
}

/** One reconnect attempt. Reuses `connectSlot` exactly the way
 *  `handleSwapSlot` does — the only difference is *why* a new connection is
 *  being opened, not how. */
async function tryReconnect() {
  // Something else already resolved this (a stop, the producer leaving,
  // a manual swap) — nothing left to reconnect for.
  if (!state.producerId || !activeProfile || state.status !== "connecting") {
    reconnectAttempt = 0;
    return;
  }

  const producerAtAttempt = state.producerId;
  const profile = activeProfile;

  let ws;
  try {
    ws = await connectSlot(activeSlot, profile);
  } catch (cause) {
    if (state.producerId === producerAtAttempt && state.status === "connecting") {
      state.error = `เชื่อมต่อใหม่ไม่สำเร็จ: ${describeError(cause)} — จะลองอีกครั้ง`;
      broadcastState();
      scheduleReconnect();
    }
    return;
  }

  if (state.producerId !== producerAtAttempt || state.status !== "connecting") {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    return;
  }

  reconnectAttempt = 0;
  socket = ws;
  state.status = "streaming";
  state.error = null;
  broadcastState();
}

/**
 * Requests a token and opens the socket for a fresh recording. Only proceeds
 * for the tab that is currently the producer — a stale message from a tab
 * that lost a race against another `claim-producer` is simply ignored.
 */
async function handleBeginStream(msg) {
  const claimant = state.producerId;
  if (msg.tabId !== claimant) {
    return;
  }

  closingSocket = false;
  state.error = null;
  broadcastState();

  let ws;
  try {
    ws = await connectSlot(activeSlot, msg.profile);
  } catch (cause) {
    if (state.producerId === claimant) {
      state.status = "idle";
      state.error = describeError(cause);
      state.producerId = null;
      broadcastState();
    }
    return;
  }

  // A stop (or a second begin-stream) may have landed while connecting.
  if (state.producerId !== claimant) {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    return;
  }

  socket = ws;
  activeProfile = msg.profile;
  state.status = "streaming";
  startElapsedTimer();
  broadcastState();
}

/** Applies one `Turn` message — mirrors `applyTurn` in `useAssemblyStream`. */
function applyTurn(message, label) {
  const text = (message.transcript || "").trim();

  if (!message.end_of_turn) {
    state.partial = text;
    broadcastState();
    return;
  }

  state.partial = "";
  if (!text) {
    broadcastState();
    return;
  }

  const id = `${label}-${message.turn_order}`;
  const index = state.turns.findIndex((turn) => turn.id === id);
  const incoming = {
    id,
    text,
    isFormatted: Boolean(message.turn_is_formatted),
  };

  if (index === -1) {
    state.turns = state.turns.concat([incoming]);
    queueTranslation(incoming);
    broadcastState();
    return;
  }

  const existing = state.turns[index];
  // A formatted turn is the last word on that segment — a raw revision that
  // arrives afterwards must not overwrite it.
  if (existing.isFormatted && !incoming.isFormatted) {
    return;
  }
  if (existing.text === incoming.text && existing.isFormatted === incoming.isFormatted) {
    return;
  }

  const next = state.turns.slice();
  next[index] = incoming;
  state.turns = next;
  // Revisions of a turn already queued (or already translated) must not be
  // translated a second time — queueTranslation's own id guard covers this.
  queueTranslation(incoming);
  broadcastState();
}

// ── Translation ──────────────────────────────────────────────────────────

/** Checked independently per slot — slot 2 may be configured while slot 1 is
 *  not, or the other way around. */
const translationReadyBySlot = { 1: false, 2: false };
const translatedIds = new Set();
let translationQueue = [];
let translationBusy = false;
let translationAbort = null;
/**
 * Finished `{ source, translation }` pairs, in order — the display text (via
 * `composeTranslationText`) and the conversational context handed to
 * `/api/translate` for the *next* turn both come from this same list. Not
 * split by slot: it describes what this session has already translated, not
 * which model did it, so a slot swap still hands the new model continuity
 * instead of starting cold.
 */
let translationHistory = [];
let translationStreamingBuffer = "";

/** Upper bound on how many pairs are ever sent as context, independent of
 *  `CONTEXT_TOKENS` — the server trims to the configured token budget from
 *  whatever arrives, but a session running for hours has no reason to keep
 *  re-sending its entire history on every turn just to have it discarded. */
const CONTEXT_HISTORY_LIMIT = 50;

function composeTranslationText() {
  const parts = translationHistory.map((pair) => pair.translation);
  if (translationStreamingBuffer) {
    parts.push(translationStreamingBuffer);
  }
  return parts.join(" ");
}

/**
 * Checks one slot's `/api/translate` configuration once. Only a success is
 * remembered — `.env` may be filled in and the server restarted while tabs
 * stay open, and one failed check must not pin every tab to "off" for the
 * rest of the session. Mirrors `ensureConfig` in the combined app's
 * `lib/translate.ts`, generalised to a slot.
 *
 * Guarded by `slot === activeSlot` before touching anything visible: a check
 * for the slot nobody is looking at right now (kicked off in the background
 * by a swap, or by `initSlots` warming slot 2 up front) must never overwrite
 * what the *currently* active slot's status actually is.
 */
async function ensureTranslationConfig(slot) {
  if (translationReadyBySlot[slot]) {
    return true;
  }

  try {
    const response = await fetch(`/api/translate?slot=${slot}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(await describeFailure(response, "อ่านค่าตั้งของโมเดลแปลไม่สำเร็จ"));
    }
    const config = await response.json();

    if (!config) {
      if (slot === activeSlot && state.translation.status !== "off") {
        state.translation = { ...state.translation, status: "off" };
        broadcastState();
      }
      return false;
    }

    translationReadyBySlot[slot] = true;
    if (slot === activeSlot && state.translation.status === "unknown") {
      state.translation = { ...state.translation, status: "idle" };
      broadcastState();
    }
    return true;
  } catch (cause) {
    // "Configured wrongly" must surface as an error, distinct from "off".
    if (slot === activeSlot) {
      state.translation = { ...state.translation, error: describeError(cause) };
      broadcastState();
    }
    return false;
  }
}

/** Makes the visible translation status match `slot`'s own configuration the
 *  moment a swap happens, rather than however the previous slot last left
 *  it — the caller is expected to `broadcastState()` right after this. */
function refreshTranslationAvailability(slot) {
  if (translationReadyBySlot[slot]) {
    state.translation = { ...state.translation, status: "idle", error: null };
    return;
  }
  state.translation = { ...state.translation, status: "unknown", error: null };
  void ensureTranslationConfig(slot);
}

function queueTranslation(turn) {
  if (translatedIds.has(turn.id)) {
    return;
  }
  translatedIds.add(turn.id);
  translationQueue.push(turn);
  void drainTranslation();
}

/**
 * Translates queued turns one after another. Deliberately serial — parallel
 * requests would finish out of order, and a pane whose sentences arrive
 * shuffled is worse than one that lags a little. Runs once regardless of how
 * many tabs are open, which is the entire reason this lives in the hub.
 *
 * Each turn reads `activeSlot` for itself, at the moment it is actually about
 * to be translated rather than when it was queued — a slot swap this way
 * takes effect on the very next translation call, even for a turn that was
 * already waiting in line when the swap happened.
 */
async function drainTranslation() {
  if (translationBusy) {
    return;
  }
  translationBusy = true;

  try {
    while (translationQueue.length > 0) {
      const turn = translationQueue.shift();
      const slot = activeSlot;

      const available = await ensureTranslationConfig(slot);
      if (!available) {
        continue;
      }

      const controller = new AbortController();
      translationAbort = controller;
      translationStreamingBuffer = "";
      state.translation = { text: composeTranslationText(), status: "translating", error: null };
      broadcastState();

      // The most recent pairs carry the most useful continuity (open
      // pronouns, an ongoing topic); the server trims further from here
      // against the configured token budget, nearest-first — see
      // `trimContext` in `src/app/api/translate/route.ts`.
      const context = translationHistory.slice(-CONTEXT_HISTORY_LIMIT);

      let aborted = false;
      try {
        const response = await fetch(`/api/translate?slot=${slot}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: turn.text, context }),
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `แปลข้อความไม่สำเร็จ (${response.status})`;
          try {
            const body = await response.json();
            if (body && body.error) {
              message = body.error;
            }
          } catch {
            // Not JSON; the status line is all there is to report.
          }
          throw new Error(message);
        }

        if (response.body) {
          const reader = response.body.getReader();
          // A Thai or an emoji code point can straddle two chunks, so the
          // decoder stays in streaming mode until the loop ends.
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              const delta = decoder.decode(value, { stream: true });
              if (delta) {
                translationStreamingBuffer += delta;
                state.translation = {
                  text: composeTranslationText(),
                  status: "translating",
                  error: null,
                };
                broadcastState();
              }
            }
            const tail = decoder.decode();
            if (tail) {
              translationStreamingBuffer += tail;
            }
          } finally {
            reader.releaseLock();
          }
        }
      } catch (cause) {
        if (controller.signal.aborted) {
          aborted = true;
        } else {
          translationStreamingBuffer = "";
          state.translation = {
            text: composeTranslationText(),
            status: "translating",
            error: describeError(cause),
          };
          broadcastState();
        }
      } finally {
        translationAbort = null;
      }

      if (aborted) {
        // A reset or shutdown fired mid-stream — abandon the rest of the
        // queue too rather than resuming into a state that was just cleared.
        return;
      }

      const finished = translationStreamingBuffer.trim();
      translationStreamingBuffer = "";
      if (finished) {
        translationHistory.push({ source: turn.text, translation: finished });
        state.translation = { text: composeTranslationText(), status: "translating", error: null };
        broadcastState();
      }
    }
  } finally {
    translationBusy = false;
    state.translation = {
      ...state.translation,
      text: composeTranslationText(),
      status: state.translation.status === "off" ? "off" : "idle",
    };
    broadcastState();
  }
}

function resetTranslation() {
  if (translationAbort) {
    translationAbort.abort();
    translationAbort = null;
  }
  translationQueue = [];
  translatedIds.clear();
  translationHistory = [];
  translationStreamingBuffer = "";
  state.translation = {
    text: "",
    status: state.translation.status === "off" ? "off" : "idle",
    error: null,
  };
}

// ── Producer lifecycle ──────────────────────────────────────────────────

function handleClaimProducer(port, msg) {
  if (state.producerId === null || state.producerId === msg.tabId) {
    // Defensive: closes off the (otherwise unreachable through the normal
    // UI — see the note on `tryReconnect`) case of this exact tab claiming
    // again while its own earlier session still has a reconnect retry
    // pending, which would otherwise leave two attempts racing to become
    // `socket`.
    cancelReconnect();
    state.producerId = msg.tabId;
    if (state.status === "idle") {
      state.status = "connecting";
      broadcastState();
    }
    port.postMessage({ type: "producer-result", granted: true });
  } else {
    port.postMessage({
      type: "producer-result",
      granted: false,
      reason: "มีอีกแท็บกำลังถอดเสียงอยู่ในขณะนี้",
    });
  }
}

/**
 * "Stop" from any tab — not necessarily the producer.
 *
 * Closes the socket immediately rather than flushing it: an earlier version
 * asked the server to finish the in-flight turn first (`ForceEndpoint`, then
 * wait for its reply) so the sentence being spoken when stop was pressed
 * would not be lost. That reply took a few seconds to arrive in practice, and
 * `status` stayed "streaming" the whole time — pressing stop looked like it
 * had done nothing. Closing right away trades that last, still-unfinished
 * sentence for an instant response, the same trade-off an unfinished partial
 * already makes every time the mic is muted mid-word.
 */
function handleRequestStop() {
  if (socket === null && state.producerId === null && reconnectTimer === null) {
    return;
  }

  cancelReconnect();
  closingSocket = true;
  tellProducer({ type: "release-mic" });

  if (socket) {
    // `Terminate` is sent as a courtesy so the server can tear the session
    // down cleanly on its side, but nothing here waits for a reply.
    try {
      socket.send(JSON.stringify({ type: "Terminate" }));
    } catch {
      // The socket may already be past accepting sends.
    }
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    return;
  }

  // No socket ever opened (still fetching a token, or that fetch just
  // failed) — nothing to tear down but the local session bookkeeping.
  state.status = "idle";
  state.producerId = null;
  state.partial = "";
  closingSocket = false;
  stopElapsedTimer();
  broadcastState();
}

/** The producer's tab is gone (closed, crashed, or pruned) — ends the session
 *  the same way `handleRequestStop` does, minus the `Terminate` courtesy and
 *  the (now pointless) `release-mic` message: there is no tab left to send
 *  either one to. */
function handleProducerGone() {
  cancelReconnect();
  closingSocket = true;
  if (socket) {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
    return;
  }

  state.status = "idle";
  state.producerId = null;
  state.partial = "";
  closingSocket = false;
  stopElapsedTimer();
  broadcastState();
}

function handleClear() {
  state.turns = [];
  state.partial = "";
  state.error = null;
  resetTranslation();
  state.elapsedMs = 0;
  if (elapsedTimer !== null) {
    // Recording is still running — rebase the clock instead of leaving the
    // running interval overwrite the reset on its very next tick.
    elapsedStartedAt = Date.now();
  }
  broadcastState();
}

/**
 * "Switch transcribe and translate over to the other configured API set."
 * A no-op if `slotCount` is still `1` — nothing to switch to.
 *
 * While idle (or merely "connecting" — see the comment below), this only
 * updates `activeSlot`: the next `begin-stream` or translation request reads
 * it fresh, so there is nothing else to do. While a recording is actually
 * streaming, the swap is make-before-break: a second connection to the new
 * slot is opened, and only once *that* one is confirmed open does `pcm`
 * traffic move over to it — every `pcm` message routes through whatever
 * `socket` currently is, so reassigning that variable is the entire handover,
 * and there is never a moment where incoming audio has nowhere to go. The
 * outgoing connection is not simply dropped either: it is asked to flush
 * whatever turn it still had in flight and left to finish quietly in the
 * background (see `connectSlot`'s header comment on why its turns still
 * count), so a swap costs a few overlapping seconds of API usage and nothing
 * else.
 */
async function handleSwapSlot() {
  if (slotCount < 2) {
    return;
  }

  const previousSlot = activeSlot;
  const nextSlot = previousSlot === 1 ? 2 : 1;
  activeSlot = nextSlot;
  state.activeSlot = nextSlot;
  refreshTranslationAvailability(nextSlot);
  broadcastState();

  if (state.status !== "streaming") {
    // Nothing live to move. "connecting" is deliberately left to finish on
    // whichever slot its own `begin-stream` already started against — the
    // token request is already in flight by then, and racing a second one
    // against it just to save the operator one more key press is not worth
    // the extra state to track for how rarely a swap lands in that instant.
    return;
  }

  const outgoing = socket;
  const producerAtSwap = state.producerId;

  let incoming;
  try {
    incoming = await connectSlot(nextSlot, activeProfile);
  } catch (cause) {
    // Stay on the connection already running — a failed swap must never
    // interrupt a recording that was working fine a moment ago.
    activeSlot = previousSlot;
    state.activeSlot = previousSlot;
    state.error = `สลับชุด API ไม่สำเร็จ: ${describeError(cause)}`;
    refreshTranslationAvailability(previousSlot);
    broadcastState();
    return;
  }

  // Stopped, or swapped again, while the new connection was handshaking.
  if (
    activeSlot !== nextSlot ||
    state.producerId !== producerAtSwap ||
    state.status !== "streaming"
  ) {
    try {
      incoming.close();
    } catch {
      // Already closing.
    }
    return;
  }

  socket = incoming;
  broadcastState();

  windDownConnection(outgoing);
}

/** Winds an outgoing hot-swap connection down without blocking anything on
 *  it — see `handleSwapSlot`. */
function windDownConnection(ws) {
  if (!ws) {
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    } catch {
      // Already on its way down.
    }
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }, SWAP_FLUSH_GRACE_MS);
  } else {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  }
}

// ── Port lifecycle ───────────────────────────────────────────────────────

function handleTabGone(port) {
  const info = ports.get(port);
  if (info && info.tabId && info.tabId === state.producerId) {
    // Asked for directly rather than through `tellProducer`, which looks the
    // producer up in `ports` — the caller is about to remove it from there,
    // and for a *pruned* tab (as opposed to one that said `bye`) the window
    // may well still exist with a live microphone on it. Telling it to let go
    // keeps a tab that comes back from holding a mic that feeds a session the
    // hub has already ended.
    try {
      port.postMessage({ type: "release-mic" });
    } catch {
      // See broadcast().
    }
    handleProducerGone();
  }
}

function handleMessage(port, msg) {
  if (!msg || typeof msg.type !== "string") {
    return;
  }

  let info = ports.get(port);

  /**
   * A message on a port the hub is not tracking — the tab was pruned for
   * going quiet (backgrounded, screen folded, machine asleep) but is plainly
   * alive, since here is a message from it. Re-admit it rather than dropping
   * the message.
   *
   * This is the whole recovery path, and it has to live here rather than in
   * the `hello` case: dropping unknown ports before the switch meant even a
   * fresh `hello` was discarded, so a tab that had been pruned once could
   * never talk to the hub again for the rest of its life. It rendered
   * normally, animated normally, and silently did nothing at all — no state
   * updates arriving, no button reaching the hub — until it was reloaded.
   *
   * `bye` is the exception: a tab saying goodbye on a port already gone has
   * nothing left to register.
   */
  if (!info) {
    if (msg.type === "bye") {
      return;
    }
    info = { tabId: msg.tabId ?? null, lastPing: Date.now() };
    ports.set(port, info);
    // Whatever it missed while pruned, in one message. `hello` sends its own
    // snapshot below, so only anything else needs this.
    if (msg.type !== "hello") {
      try {
        port.postMessage({ type: "state", state });
      } catch {
        // See broadcast().
      }
    }
  }

  // Any message at all is proof of life, not just an explicit `ping`. Matters
  // most for the producer, which sends `pcm` ten times a second and would
  // otherwise be judged solely on a heartbeat the browser is free to throttle.
  info.lastPing = Date.now();

  switch (msg.type) {
    case "hello":
      info.tabId = msg.tabId;
      port.postMessage({ type: "state", state });
      break;

    case "ping":
      break;

    case "bye":
      handleTabGone(port);
      ports.delete(port);
      break;

    case "claim-producer":
      handleClaimProducer(port, msg);
      break;

    case "begin-stream":
      void handleBeginStream(msg);
      break;

    case "pcm":
      if (
        socket &&
        socket.readyState === WebSocket.OPEN &&
        info.tabId === state.producerId
      ) {
        socket.send(msg.buffer);
      }
      break;

    case "level":
      if (info.tabId === state.producerId) {
        broadcast({ type: "level", value: msg.value });
      }
      break;

    case "request-stop":
      handleRequestStop();
      break;

    case "clear":
      handleClear();
      break;

    case "swap-slot":
      void handleSwapSlot();
      break;

    default:
      break;
  }
}

self.onconnect = (event) => {
  const port = event.ports[0];
  ports.set(port, { tabId: null, lastPing: Date.now() });

  port.onmessage = (event) => handleMessage(port, event.data);
  // Explicit start rather than relying on the implicit start that setting
  // `onmessage` triggers per spec — both browsers honour the implicit form,
  // but the explicit call is what every cross-browser SharedWorker guide
  // recommends, and it costs nothing to be certain here.
  port.start();
};

// Prunes any tab that has gone quiet — the backstop described in the header
// comment above, for whichever tab a plain `bye` never reached.
setInterval(() => {
  const now = Date.now();
  for (const [port, info] of ports) {
    if (!info.tabId) {
      continue;
    }
    const timeout =
      info.tabId === state.producerId ? PRODUCER_PRUNE_TIMEOUT_MS : PRUNE_TIMEOUT_MS;
    if (now - info.lastPing > timeout) {
      handleTabGone(port);
      ports.delete(port);
    }
  }
}, PRUNE_CHECK_MS);

/**
 * Checked once at startup: `slotCount` decides whether the swap hotkey (or
 * the settings-panel control) does anything at all, and warming slot 2's own
 * translation check up front means the *first* swap to it does not have to
 * wait for that round trip before showing whether it is configured.
 */
async function initSlots() {
  try {
    const response = await fetch("/api/slots", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    if (payload && payload.transcribeSlotCount === 2) {
      slotCount = 2;
      state.slotCount = 2;
      broadcastState();
      void ensureTranslationConfig(2);
    }
  } catch {
    // Stay at the safe default (1) — the swap hotkey simply won't do anything.
  }
}

void initSlots();

// Checked once at startup so a tab opened straight onto the translate view
// shows "not configured" (or the real error) immediately instead of waiting
// for the first finished turn.
void ensureTranslationConfig(1);
