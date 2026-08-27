/**
 * Mints a short-lived AssemblyAI streaming token.
 *
 * The account key never leaves this process. The browser gets a token that is
 * valid for `ASSEMBLYAI_TOKEN_EXPIRES_IN` seconds and passes it as `?token=` on
 * the WebSocket handshake, which is the only way to authenticate there — the
 * handshake cannot carry an `Authorization` header.
 *
 * The desktop build reimplemented this as the `get_stream_token` command in
 * `src-tauri/src/token.rs`. Same rules, same messages.
 *
 * `?slot=2` mints a token against the alternate (`_B`-suffixed) API set
 * instead — see `ApiSlot` in `src/lib/server/config.ts`. The hub calls this
 * with whichever slot is currently active, so a slot swap is nothing more
 * than opening a second connection with a different `slot` on the query
 * string; this route itself has no notion of "switching" at all.
 */

import { connection } from "next/server";

import { isAssemblyAiCloud } from "@/lib/aai";
import { parseApiSlot, streamConfig } from "@/lib/server/config";

interface TokenResponse {
  token?: string;
}

export async function GET(request: Request) {
  // A token lives for seconds. `connection()` keeps this off any prerender or
  // cache path, so what goes out is always freshly minted.
  await connection();

  const slot = parseApiSlot(new URL(request.url).searchParams);
  const suffix = slot === 2 ? "_B" : "";
  const { tokenEndpoint, wsEndpoint, apiKey, expiresInSeconds, maxSessionSeconds } =
    streamConfig(slot);

  if (!apiKey) {
    // A self-hosted v3 server may accept unauthenticated connections; an
    // AssemblyAI host never does, so guessing there only produces a confusing
    // handshake rejection later.
    if (isAssemblyAiCloud(wsEndpoint)) {
      return Response.json(
        {
          error: `ยังไม่ได้ตั้งค่า ASSEMBLYAI_API_KEY${suffix} — ใส่คีย์ใน .env หรือชี้ ASSEMBLYAI_WS_ENDPOINT${suffix} ไปเซิร์ฟเวอร์ที่ไม่ต้องยืนยันตัวตน`,
        },
        { status: 500 },
      );
    }

    return Response.json({ token: null, wsEndpoint });
  }

  let url: URL;
  try {
    url = new URL(tokenEndpoint);
  } catch {
    return Response.json(
      {
        error: `ASSEMBLYAI_TOKEN_ENDPOINT${suffix} ไม่ใช่ URL ที่ถูกต้อง — ได้รับ "${tokenEndpoint}"`,
      },
      { status: 500 },
    );
  }

  url.searchParams.set("expires_in_seconds", String(expiresInSeconds));
  url.searchParams.set("max_session_duration_seconds", String(maxSessionSeconds));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: apiKey },
      cache: "no-store",
    });
  } catch (cause) {
    return Response.json(
      {
        error: `ติดต่อ ${url.host} ไม่ได้: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      { status: 502 },
    );
  }

  if (!response.ok) {
    // The upstream body is usually the actionable part (an invalid key, a
    // suspended account), so it is passed through rather than summarised.
    const detail = (await response.text()).trim();
    return Response.json(
      {
        error: `ขอโทเค็นไม่สำเร็จ (${response.status})${detail ? `: ${detail}` : ""}`,
      },
      { status: 502 },
    );
  }

  let payload: TokenResponse;
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    // A proxy or a captive portal answering 200 with HTML lands here.
    payload = {};
  }

  if (!payload.token) {
    return Response.json(
      { error: "เซิร์ฟเวอร์โทเค็นตอบกลับมาโดยไม่มีโทเค็น" },
      { status: 502 },
    );
  }

  return Response.json({ token: payload.token, wsEndpoint });
}
