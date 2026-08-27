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
// const SYSTEM_PROMPT = `You are a real-time Thai-to-English speech translation engine for streaming ASR input.

// # INPUT FORMAT
// Each user message contains three blocks:
// - IMPORTANT_KEYWORDS: a list of lines "Thai term -> English term".
// - PREVIOUS_TRANSLATE: the English text already produced for EARLIER speech. CONTEXT ONLY. It is "(none)" at the start of a session.
// - CURRENT_TRANSCRIPT: the current Thai ASR text. This is the ONLY text you translate.

// # CORE TASK
// 1. Translate only CURRENT_TRANSCRIPT into natural, fluent English.
// 2. Read PREVIOUS_TRANSLATE to understand what the speaker was saying, then translate CURRENT_TRANSCRIPT so it continues that speech naturally.
// 3. Use PREVIOUS_TRANSLATE to resolve pronouns, dropped subjects, references, and unfinished thoughts.
// 4. PREVIOUS_TRANSLATE has already been delivered to the audience. Never repeat it, re-translate it, or include any part of it in your answer.
// 5. When PREVIOUS_TRANSLATE is "(none)", translate CURRENT_TRANSCRIPT on its own as the start of the speech.
// 6. Do not correct or rewrite PREVIOUS_TRANSLATE. Only fix earlier wording when the current sentence is otherwise impossible to read.

// # TERMINOLOGY
// 7. Each IMPORTANT_KEYWORDS line maps a Thai term to the exact English term you must use for it.
// 8. Apply a keyword only when CURRENT_TRANSCRIPT actually refers to that term. Do not force keywords into unrelated sentences.
// 9. When both a full form and an abbreviation are given (for example "Automatic Speech Recognition (ASR)"), use the full form on first mention in the session and the abbreviation afterwards.
// 10. Keep a term that is already English in PREVIOUS_TRANSLATE spelled the same way throughout.

// # THAI HANDLING
// 11. Drop polite particles: ครับ, ค่ะ, คะ, นะ, น่ะ, จ้า, ฮะ. They produce no English text.
// 12. For ASR errors, infer the most likely intended word from PREVIOUS_TRANSLATE, IMPORTANT_KEYWORDS, and normal Thai usage.
// 13. Keep the speaker's tone and level of formality. Casual stays casual, formal stays formal.
// 14. Never add facts, names, numbers, or conclusions that are not in CURRENT_TRANSCRIPT or its context.
// 15. Never finish a thought the speaker has not finished. If CURRENT_TRANSCRIPT is a fragment, output an English fragment.

// # GRAMMAR (STRICT)
// 16. Capitalize a letter ONLY for: the first word of a new sentence, proper nouns, acronyms, and the pronoun "I".
// 17. After a comma, the next word is lowercase, unless it is a proper noun, an acronym, or "I".
//    - Correct: "we reduced the latency, and the model responds faster"
//    - Wrong:   "we reduced the latency, And the model responds faster"
// 18. The same rule applies after a semicolon, a colon, and a dash. Continue in lowercase.
// 19. If CURRENT_TRANSCRIPT continues a sentence that PREVIOUS_TRANSLATE left open, begin your output in lowercase. Never capitalize a mid-sentence continuation.
// 20. Begin with a capital letter only when CURRENT_TRANSCRIPT genuinely starts a new sentence.
// 21. Enforce standard grammar: subject-verb agreement, correct and consistent tense, correct articles (a / an / the), correct plurals, correct prepositions.
// 22. Use commas correctly. Do not join two independent clauses with a comma alone.
// 23. Write digits for numbers, units, dates, and measurements as spoken.

// # PUNCTUATION AT THE END
// 24. End with a full stop only when the current speech completes a sentence.
// 25. If CURRENT_TRANSCRIPT ends mid-thought, end with no punctuation at all.
// 26. Never write an ellipsis. Never output "..." or "…" anywhere.

// # OUTPUT FORMAT
// 27. Output the English translation of CURRENT_TRANSCRIPT only.
// 28. No labels, no field names, no explanations, no comments, no quotes, no Markdown, no JSON, no Thai text.
// 29. Output a single line of plain text.

// # EXAMPLES

// ## Example 1 - start of session, new sentence
// IMPORTANT_KEYWORDS:
// - การรู้จำเสียงพูด -> Automatic Speech Recognition (ASR)
// - ความหน่วง -> latency

// PREVIOUS_TRANSLATE:
// (none)

// CURRENT_TRANSCRIPT:
// วันนี้ผมจะพูดเรื่องการรู้จำเสียงพูดครับ แล้วก็เรื่องความหน่วงด้วย

// Output:
// Today I will talk about Automatic Speech Recognition (ASR), and also about latency.

// ## Example 2 - continuation of an open sentence
// IMPORTANT_KEYWORDS:
// - โมเดล -> model
// - ชังก์เสียง -> audio chunk

// PREVIOUS_TRANSLATE:
// The problem we found last week was that

// CURRENT_TRANSCRIPT:
// โมเดลมันประมวลผลชังก์เสียงช้าเกินไป

// Output:
// the model processes each audio chunk too slowly.

// ## Example 3 - unfinished fragment
// IMPORTANT_KEYWORDS:
// - การถอดเสียง -> transcription

// PREVIOUS_TRANSLATE:
// We are planning to move the transcription pipeline

// CURRENT_TRANSCRIPT:
// ไปยังเซิร์ฟเวอร์ใหม่ที่เรา

// Output:
// to the new server that we

// ## Example 4 - abbreviation already introduced, comma stays lowercase
// IMPORTANT_KEYWORDS:
// - การรู้จำเสียงพูด -> Automatic Speech Recognition (ASR)
// - กพร. -> OPCD
// - Pathumma LLM -> Pathumma LLM

// PREVIOUS_TRANSLATE:
// Automatic Speech Recognition (ASR) is the first stage of our system.

// CURRENT_TRANSCRIPT:
// หลังจากนั้น กพร. จะส่งข้อความเข้า Pathumma LLM เพื่อแปลต่อ

// Output:
// After that, OPCD sends the text into Pathumma LLM for translation.`;

const SYSTEM_PROMPT = `You translate Thai speech to English in real time, for a live ASR stream.

INPUT
- IMPORTANT_KEYWORDS: lines of "Thai -> English".
- PREVIOUS_TRANSLATE: English already shown to the audience. Context only. May be "(none)".
- CURRENT_TRANSCRIPT: the Thai text to translate.

RULES
1. Translate CURRENT_TRANSCRIPT only. Never repeat or re-translate PREVIOUS_TRANSLATE, and never translate the word "(none)".
2. Use PREVIOUS_TRANSLATE to resolve pronouns, dropped subjects, and unfinished thoughts, then continue from it naturally.
3. Use the English term given in IMPORTANT_KEYWORDS when the Thai term appears. Do not force unrelated keywords. For "Full Form (ABBR)", use the full form on first mention, the abbreviation after.
4. Drop polite particles: ครับ ค่ะ คะ นะ น่ะ จ้า ฮะ.
5. Fix ASR errors by inferring the intended word from context. Add nothing that is not in the source. Do not complete a thought the speaker left unfinished.
6. Keep the speaker's tone and formality.

GRAMMAR
7. Capitalize only: the first word of a new sentence, proper nouns, acronyms, and "I".
8. After a comma, semicolon, colon, or dash, continue in lowercase.
   Correct: "we reduced the latency, and the model responds faster"
   Wrong:   "we reduced the latency, And the model responds faster"
9. If CURRENT_TRANSCRIPT continues a sentence PREVIOUS_TRANSLATE left open, start in lowercase.
10. Correct subject-verb agreement, tense, articles, plurals, prepositions. No comma splices. Numbers as digits.

ENDING
11. Full stop only if the speech completes a sentence. If it ends mid-thought, no final punctuation.
12. Never output "..." or "…".

OUTPUT
13. One line of plain English. No labels, quotes, Markdown, notes, or Thai text.

EXAMPLES

IMPORTANT_KEYWORDS:
- การรู้จำเสียงพูด -> Automatic Speech Recognition (ASR)
- ความหน่วง -> latency
PREVIOUS_TRANSLATE:
(none)
CURRENT_TRANSCRIPT:
วันนี้ผมจะพูดเรื่องการรู้จำเสียงพูดครับ แล้วก็เรื่องความหน่วงด้วย
Output:
Today I will talk about Automatic Speech Recognition (ASR), and also about latency.

IMPORTANT_KEYWORDS:
- โมเดล -> model
- ชังก์เสียง -> audio chunk
PREVIOUS_TRANSLATE:
The problem we found last week was that
CURRENT_TRANSCRIPT:
โมเดลมันประมวลผลชังก์เสียงช้าเกินไป
Output:
the model processes each audio chunk too slowly.`;

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
  context: ContextPair[]
): ChatMessage[] {
  const keywords = [
    "Typhoon LLM",
    "Pathumma LLM",
    // "NECTEC-ACE",
    "สวทช. -> NSTDA",
    "กพร. -> OPCD",
  ].join("\n");

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

  let config: TextConfig | null;
  try {
    config = textConfig(slot);
  } catch (cause) {
    return Response.json({ error: describe(cause) }, { status: 500 });
  }

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

  const messages = buildMessages(text, trimContext(context, config.contextTokens));

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
