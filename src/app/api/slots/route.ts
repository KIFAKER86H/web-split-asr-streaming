/**
 * Whether a second transcribe API set is configured at all.
 *
 * The hub reads this once at startup to decide whether the slot-swap hotkey
 * (`F3` by default — see `src/lib/hotkeys.ts`) does anything. It is a cheap,
 * side-effect-free check of `.env` — unlike `/api/token`, answering it never
 * mints anything.
 */

import { connection } from "next/server";

import { transcribeSlotCount } from "@/lib/server/config";

export async function GET() {
  await connection();
  return Response.json({ transcribeSlotCount: transcribeSlotCount() });
}
