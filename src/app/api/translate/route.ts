/**
 * Translation for the lower caption pane.
 *
 * `GET` reports whether translation is configured at all; `POST` streams the
 * English rendering of one finished turn back as plain UTF-8 text, so the pane
 * fills in word by word instead of appearing all at once.
 *
 * The desktop build ran the OpenAI SDK inside the webview and fetched
 * `TEXT_API_KEY` through the `get_text_config` command — reasonable there, where
 * the webview *is* the application and the key already sits in the `.env` next
 * to the executable. On the web that key would be handed to every visitor, so
 * the call runs here instead. It also means `TEXT_BASE_URL` may point at a host
 * only the server can reach, which is the common case for a self-hosted model.
 *
 * `?slot=2` reads the alternate (`_B`-suffixed) model instead of the default
 * one — see `ApiSlot` in `src/lib/server/config.ts`. Each slot's translation
 * config is entirely independent: slot 2 can be configured while slot 1 is
 * not, or the other way around.
 *
 * `POST`'s body can carry `context`: prior `{ source, translation }` pairs
 * from earlier in the same session, which the hub sends along so this turn
 * is not translated in a vacuum — a pronoun, a name, or an ongoing topic from
 * a sentence ago otherwise has nothing to anchor it. `CONTEXT_TOKENS` (per
 * slot) is the budget that context is trimmed to before it ever reaches the
 * model — see `trimContext`.
 */

import { connection } from "next/server";
import OpenAI from "openai";

import { parseApiSlot, textConfig, type TextConfig } from "@/lib/server/config";

/**
 * Kept terse and absolute. A chattier prompt makes the model add notes like
 * "Here is the translation:", which would end up on screen as a caption.
 *
 * The punctuation rules exist because a turn is cut at a *pause*, not at a
 * sentence boundary — so a turn very often arrives as half a sentence. Left to
 * itself the model tidies that into something finished: it appends a full stop
 * the speaker never reached, or pads the fragment out into a grammatical
 * sentence, and the next turn then reads as a fresh thought rather than the
 * continuation it actually is. An ellipsis is the other reflex to head off —
 * it is punctuation about the transcript rather than a translation of what was
 * said, and on a caption screen it just flickers.
 */

// ********************************************************************************************************************
// const SYSTEM_PROMPT_TH2EN = `System: You are a real-time streaming ASR translator (Thai to English).
// Inputs: IMPORTANT_KEYWORDS, translation (previous English context), source (current Thai speech).

// Task Instruction:
// Translate ONLY the 'source' text into fluent English. Use 'translation' for context only. NEVER output the 'translation'.

// Constraints:
// 1. Ignore polite particles (ครับ, ค่ะ, นะ). NEVER translate them as "yes" or "yeah".
// 2. Preserve fragments. Do not complete unfinished sentences.
// 3. Output raw text only. No punctuation like ellipses (...).

// Few-Shot Examples:
// [Example 1 - Incomplete thought & Polite particle]
// source: "สวัสดีครับ วันนี้เราจะมา"
// output: Hello, today we will

// [Example 2 - Polite particle alone]
// source: "เข้าใจแล้วค่ะ"
// output: Understood.

// [Example 3 - Confirmation + Particle]
// source: "ใช่ครับ"
// output: Yes.

// [Example 4 - Continuation from context]
// translation: "So we should"
// source: "เริ่มโปรเจกต์ใหม่กันเลยนะ"
// output: start the new project right away.

// Now process the actual input. Output ONLY the raw English text.

// *** When you found the only Empty string - polite particle or something like this do not translate or generate word just give me a brank respond.
// `
// ********************************************************************************************************************

const SYSTEM_PROMPT_TH2EN = `
System: You are a real-time streaming ASR translator (Thai to English).
Inputs: IMPORTANT_KEYWORDS, translation (previous English context), source (current Thai speech).

Task Instruction:
Translate ONLY the 'source' text into fluent English. Use 'translation' for context only. NEVER output the 'translation'.

Constraints:
1. Buffer Incomplete Chunks: If the 'source' is cut off mid-thought or too severely incomplete to translate accurately (e.g. hanging subjects, hanging conjunctions), output exactly: " "
2. Polite Particles: If 'ครับ/ค่ะ/นะ' appear with other words, ignore them. But if the ENTIRE 'source' is just 'ครับ' or 'ค่ะ' (used as an acknowledgment), translate it as "Yes." NEVER output an empty string.
3. Output raw text only. No punctuation like ellipses (...).

Few-Shot Examples:
[Example 1 - Severely incomplete chunk]
source: "เพราะว่าตอนที่"
output: " "

[Example 2 - Incomplete thought & Polite particle]
source: "สวัสดีครับ วันนี้เราจะมา"
output: Hello, today we will

[Example 3 - Standalone Polite particle (Acknowledgment)]
source: "ครับ"
output: Yes.

[Example 4 - Polite particle with meaning]
source: "เข้าใจแล้วค่ะ"
output: Understood.

[Example 5 - Continuation from context]
translation: "So we should"
source: "เริ่มโปรเจกต์ใหม่กันเลยนะ"
output: start the new project right away.

Now process the actual input. Output ONLY the raw English text, or  " ".
**** '" "' is space not any charactor give it like nothings to show, do not response " "
`

// const SYSTEM_PROMPT_EN2TH = `System: You are a real-time English-to-Thai streaming ASR translator.
// Inputs: IMPORTANT_KEYWORDS (terminology), translation (previous Thai context), source (current English ASR).

// Task: Translate ONLY the 'source' into fluent Thai. Use 'translation' STRICTLY as context (e.g., resolving pronouns). NEVER repeat or retranslate the 'translation'.

// Anti-Hallucination & Constraints:
// - Strict Fidelity: Translate exactly what is said. Do not invent information, guess missing words, or complete unfinished thoughts. If 'source' is a fragment, output a fragment.
// - ASR Errors: Infer meaning from context, but do NOT add details that were not spoken.
// - Omissions: Ignore English filler words (um, uh, like, you know).
// - Tone & Terminology: Maintain original formality (use ครับ/ค่ะ appropriately). Strictly apply IMPORTANT_KEYWORDS.
// - Output Format: Output ONLY the raw Thai translation. NO explanations, markdown, quotes, or labels.
// - Formatting: Use natural Thai spacing. Do NOT force sentence closures for incomplete thoughts. NEVER output ellipses ('...' or '…').`;
const SYSTEM_PROMPT_EN2TH = `System: You are a real-time streaming ASR translator (English to Thai).
Inputs: IMPORTANT_KEYWORDS, translation (previous Thai context), source (current English speech).

Task Instruction:
Translate ONLY the 'source' text into fluent Thai. Use 'translation' for context only. NEVER output the 'translation'.

Constraints:
1. Fragment Translation: If the 'source' is cut off mid-thought, translate the fragment as it is without completing the sentence.
2. Gender-Neutral Language (CRITICAL): Do NOT assume the speaker's gender. NEVER use gender-specific pronouns like "ผม" or "ดิฉัน". Instead, omit the pronoun entirely (drop the subject) or use a neutral term like "เรา". NEVER add gendered polite particles like "ครับ" or "ค่ะ".
3. Filler Words: Ignore filler words (um, uh, like, you know) when they appear with other text. 
4. Output raw text only. No punctuation like ellipses (...).

Few-Shot Examples:
[Example 1 - Incomplete chunk]
source: "so when we were"
output: ดังนั้นตอนที่เรา

[Example 2 - Incomplete thought, Filler, & Gender Neutrality]
source: "So I think um we should probably"
output: ดังนั้นคิดว่าเราอาจจะควร
(Note: 'I' is omitted instead of using 'ผม'. Filler 'um' is dropped. Translated as a fragment.)

[Example 3 - Continuation]
translation: "ดังนั้นคิดว่าเราอาจจะควร"
source: "deploy this to production today."
output: ดีพลอยขึ้นโปรดักชันวันนี้เลย

[Example 4 - Gender neutral sentence]
source: "I am very happy to be here."
output: รู้สึกดีใจมากที่ได้มาที่นี่
(Note: Omitted 'I' to remain gender-neutral. No 'ครับ' or 'ค่ะ' at the end.)

Now process the actual input. Output ONLY the raw Thai text.`;

/** Long enough for any single spoken turn, short enough to bound a runaway. */
const MAX_TOKENS = 512;

/** Defensive ceiling on a forged request, independent of the hub's own
 *  `CONTEXT_HISTORY_LIMIT` — nothing here trusts the caller to have applied
 *  either that limit or `CONTEXT_TOKENS` before this route sees the body. */
const MAX_CONTEXT_PAIRS = 200;
/** A single turn is a sentence or two of live speech, never a document —
 *  anything past this in one field is not context, it's abuse. */
const MAX_CONTEXT_CHARS = 4_000;

interface ContextPair {
  source: string;
  translation: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Pulls a usable `context` array out of a parsed request body, dropping
 *  anything that does not look like a `{ source, translation }` pair rather
 *  than rejecting the whole request over one bad entry. */
function parseContext(value: unknown): ContextPair[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const pairs: ContextPair[] = [];
  for (const entry of value.slice(-MAX_CONTEXT_PAIRS)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { source, translation } = entry as Record<string, unknown>;
    if (typeof source !== "string" || typeof translation !== "string") {
      continue;
    }
    const trimmedSource = source.trim().slice(0, MAX_CONTEXT_CHARS);
    const trimmedTranslation = translation.trim().slice(0, MAX_CONTEXT_CHARS);
    if (trimmedSource && trimmedTranslation) {
      pairs.push({ source: trimmedSource, translation: trimmedTranslation });
    }
  }
  return pairs;
}

/**
 * ~4 characters per token is the usual rough guide for English; kept a touch
 * tighter here since a fair share of what passes through this route is Thai,
 * which most tokenizers pack denser than that. Wrong by some margin either
 * way, but this is a soft budget for how much context to bother including —
 * not a bill — so an approximation with a safety margin is the right amount
 * of effort, not a real tokenizer dependency.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Keeps the most recent pairs that fit inside `budgetTokens`, working
 * backwards from the newest — the sentence spoken thirty seconds ago is far
 * more likely to matter to *this* one than something from ten minutes back.
 * `budgetTokens <= 0` (the `CONTEXT_TOKENS=0` case) turns context off
 * entirely, translating each turn in isolation exactly as this route always
 * did before `context` existed.
 */

function trimContext(pairs: ContextPair[], budgetTokens: number): ContextPair[] {
  if (budgetTokens <= 0) {
    return [];
  }

  const kept: ContextPair[] = [];
  let used = 0;
  for (let i = pairs.length - 1; i >= 0; i -= 1) {
    const pair = pairs[i];
    const cost = (pair.source).length + estimateTokens(pair.translation);
    if (used + cost > budgetTokens) {
      break;
    }
    used += cost;
    kept.unshift(pair);
  }
  return kept;
}

function buildMessages(
  text: string,
  context: ContextPair[],
  slot_number : number
): ChatMessage[] {
  const keywords = [
    // "Typhoon LLM",
    // "Pathumma LLM",
    // "NECTEC-ACE",
    "สวทช. -> NSTDA",
    "กพร. -> OPCD",
  ].join("\n");
  let SYSTEM_PROMPT : string ;
  if (slot_number == 1) {
    SYSTEM_PROMPT = SYSTEM_PROMPT_TH2EN ;
  }
  else{
    SYSTEM_PROMPT = SYSTEM_PROMPT_EN2TH ;
  }
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
  ];

  const previousTranscript = context
    .map((pair) => pair.source)
    .join("\n");

  const previousTranslate = context
    .map((pair) => pair.translation)
    .join("\n");

  const userPrompt = [
    "IMPORTANT_KEYWORDS:",
    keywords,
    "",
    // "PREVIOUS_TRANSCRIPT:",
    // previousTranscript || "(none)",
    // "",
    "PREVIOUS_TRANSLATE:",
    previousTranslate || "(none)",
    "",
    "CURRENT_TRANSCRIPT:",
    text,
  ].join("\n");
  // console.log(userPrompt)
  messages.push({
    role: "user",
    content: userPrompt,
  });

  return messages;
}

/**
 * Opens one streaming completion.
 *
 * A separate function so the stream's type comes from inference — the SDK moves
 * its internal module paths between majors, and nothing here needs to name them.
 */
function openStream(config: TextConfig, messages: ChatMessage[], signal: AbortSignal) {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    // Some servers reject an absent key outright; the value is ignored by the
    // ones that do not check it.
    apiKey: config.apiKey || "unused",
  });
  

  return client.chat.completions.create(
    {
      model: config.model,
      stream: true,
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      messages,
    },
    // The browser aborts when the pane is reset or the page goes away, and Next
    // forwards that here; carrying the signal through cancels the generation
    // instead of paying for tokens nobody will read.
    { signal },
  );
}

/**
 * Whether the lower pane has a model behind it.
 *
 * `null` means "not configured", which is a normal state; an error response
 * means "configured, but wrongly" — the two must not look the same on screen.
 * Only the model name is disclosed: the endpoint and its key stay here.
 */
export async function GET(request: Request) {
  // Reads `process.env`, so it must never be answered from a prerender.
  await connection();

  const slot = parseApiSlot(new URL(request.url).searchParams);
  try {
    const config = textConfig(slot);
    return Response.json(config ? { model: config.model } : null);
  } catch (cause) {
    return Response.json({ error: describe(cause) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const slot = parseApiSlot(new URL(request.url).searchParams);
  const suffix = slot === 2 ? "_B" : "";
  console.log(slot)
  let config: TextConfig | null;
  try {
    config = textConfig(slot);
  } catch (cause) {
    return Response.json({ error: describe(cause) }, { status: 500 });
  }

  // console.log(config)

  if (!config) {
    return Response.json(
      {
        error: `ยังไม่ได้ตั้งค่าโมเดลแปล — เพิ่ม TEXT_BASE_URL${suffix} และ TEXT_MODEL_NAME${suffix} ใน .env`,
      },
      { status: 503 },
    );
  }

  let text = "";
  let context: ContextPair[] = [];
  let userpromt = ""
  try {
    const body = (await request.json()) as { text?: unknown; context?: unknown };
    if (typeof body.text === "string") {
      text = body.text.trim();
      
    }
    context = parseContext(body.context);
  } catch {
    // A malformed body is indistinguishable from an empty one for our purposes.
  }

  if (!text) {
    return Response.json({ error: "ไม่มีข้อความให้แปล" }, { status: 400 });
  }

  const messages = buildMessages(text, trimContext(context, config.contextTokens), slot);

  // Awaited before the response is returned, so a refused connection or a
  // rejected key still arrives as a readable JSON error rather than as a stream
  // that breaks on its first chunk.
  let stream: Awaited<ReturnType<typeof openStream>>;
  try {
    stream = await openStream(config, messages, request.signal);
  } catch (cause) {
    return Response.json({ error: describe(cause) }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            controller.enqueue(encoder.encode(delta));
          }
        }
        controller.close();
      } catch (cause) {
        // Nothing can be said in-band once bytes are on the wire, so the stream
        // is faulted instead: the reader sees it break mid-sentence rather than
        // treating a truncated translation as a finished one.
        controller.error(cause);
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Keeps nginx and friends from holding the deltas back until the response
      // ends, which would undo the point of streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
