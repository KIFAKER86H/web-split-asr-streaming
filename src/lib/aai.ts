/** Shared configuration and message shapes for AssemblyAI Universal-Streaming v3. */

/** Used when `ASSEMBLYAI_WS_ENDPOINT` is not set. */
export const DEFAULT_WS_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";

/** Used when `ASSEMBLYAI_TOKEN_ENDPOINT` is not set. */
export const DEFAULT_TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token";

/** The worklet assumes this rate when sizing its 100 ms chunks. */
export const SAMPLE_RATE = 16_000;

export interface StreamProfile {
  id: string;
  label: string;
  speechModel: string;
  languageCodes?: string[];
  languageDetection?: boolean;
}

export const STREAM_PROFILES: StreamProfile[] = [
  {
    id: "multilingual",
    label: "หลายภาษา (ตรวจอัตโนมัติ)",
    speechModel: "universal-streaming-multilingual",
    languageDetection: true,
  },
  {
    id: "thai",
    label: "ไทย",
    speechModel: "universal-streaming-multilingual",
    languageCodes: ["th"],
  },
  {
    id: "english",
    label: "อังกฤษ",
    speechModel: "universal-streaming-english",
  },
  {
    id: "pro",
    label: "Universal 3.5 Pro",
    speechModel: "universal-3-5-pro",
  },
];

/** Hosts that always require a token; anything else may be an unauthenticated deployment. */
export function isAssemblyAiCloud(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.endsWith("assemblyai.com");
  } catch {
    return false;
  }
}

/**
 * Builds the handshake URL. The base comes from the server so the endpoint can
 * be repointed (data residency, a proxy, a self-hosted server) by editing
 * `.env` alone. `token` is null for deployments that need no auth.
 */
export function buildSocketUrl(
  endpoint: string,
  token: string | null,
  profile: StreamProfile,
): string {
  const url = new URL(endpoint);
  if (token) {
    url.searchParams.set("token", token);
  }
  url.searchParams.set("encoding", "pcm_s16le");
  url.searchParams.set("sample_rate", String(SAMPLE_RATE));
  url.searchParams.set("speech_model", profile.speechModel);

  if (profile.languageCodes?.length) {
    url.searchParams.set("language_codes", profile.languageCodes.join(","));
  }

  if (profile.languageDetection) {
    url.searchParams.set("language_detection", "true");
  }

  return url.toString();
}

export interface TurnMessage {
  type: "Turn";
  turn_order: number;
  turn_is_formatted: boolean;
  end_of_turn: boolean;
  transcript: string;
}

export interface BeginMessage {
  type: "Begin";
  id: string;
  expires_at: number;
}

export interface TerminationMessage {
  type: "Termination";
  audio_duration_seconds: number;
  session_duration_seconds: number;
}

export type ServerMessage =
  | TurnMessage
  | BeginMessage
  | TerminationMessage
  | { type: string };

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as ServerMessage;
    }
  } catch {
    // Non-JSON frames are not part of the protocol; ignore them.
  }

  return null;
}

/** Maps WebSocket close codes onto something a user can act on. */
export function describeCloseCode(code: number, reason: string): string | null {
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
