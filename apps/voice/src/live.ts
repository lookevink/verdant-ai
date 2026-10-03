// Gemini Live (Vertex AI) setup for the Verdant sprout, and the browser ⇄ relay message protocol.
// The setup is fixed here, server-side: browsers can send audio, short narration and tool results, never a model,
// prompt or tool configuration of their own.
import { createHmac, timingSafeEqual } from "node:crypto";

export type LiveConfig = { project: string; location: string; model: string; voice: string };

export function liveUrl(location: string) {
  const host = location === "us" || location === "eu" ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;
  return `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

export const narrationPrefix = "ANALYST RESULT:";
const instruction = `You are Sprout, the voice of Verdant: a small, warm, curious seedling who helps people explore climate and
agricultural evidence. Speak briefly (one or two short sentences), plainly and kindly.

You know no data yourself. Never state numbers, dates, places or findings about climate, weather, crops or datasets from your own
knowledge. When the user asks anything that needs data or analysis, call ask_verdant with their request rewritten as one complete,
standalone question (keep every place, period, variable and comparison they mentioned), then say in a few words that you're looking
into it. Follow-up requests ("now chart it", "what about 2003?") go to ask_verdant too. If they ask you to stop or cancel, call
stop_analysis.

A message that starts with "${narrationPrefix}" comes from Verdant's analyst. Read the text after the prefix aloud exactly as written:
do not add, drop or change words, and do not comment on it.

For greetings or questions about what you can do, answer briefly: Verdant's analyst can find published climate and agricultural
datasets, check their coverage and provenance, compute statistics, draw charts and write a report with its methodology.`;

export function setupMessage(config: LiveConfig, resumeHandle?: string) {
  return { setup: {
    model: `projects/${config.project}/locations/${config.location}/publishers/google/models/${config.model}`,
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } }, languageCode: "en-US" } },
    systemInstruction: { parts: [{ text: instruction }] },
    tools: [{ functionDeclarations: [
      { name: "ask_verdant", description: "Send the user's question to Verdant's research analyst, which retrieves and analyzes Verdant data and writes a report. The answer arrives later as an ANALYST RESULT message.",
        parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "The complete, standalone question." } }, required: ["question"] } },
      { name: "stop_analysis", description: "Stop the analysis that is currently running.", parameters: { type: "OBJECT", properties: {} } },
    ] }],
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  } };
}

/** Tickets are minted by the API (PLAYGROUND_VOICE_SECRET): `<session id>.<expiry seconds>.<HMAC-SHA256>`. */
export function verifyTicket(ticket: unknown, secret: string, now = Date.now()) {
  if (typeof ticket !== "string") return null;
  const match = /^([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match) return null;
  const [, session, expires, mac] = match as unknown as [string, string, string, string];
  const expected = createHmac("sha256", secret).update(`${session}.${expires}`).digest("base64url");
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) || Number(expires) * 1000 < now) return null;
  return { session, expires: Number(expires) * 1000 };
}

type Browser =
  | { type: "hello"; ticket: string }
  | { type: "audio"; data: string }
  | { type: "audio_end" }
  | { type: "narrate"; text: string }
  | { type: "tool_result"; id: string; name: string; response: Record<string, unknown> };

/** Translate one browser message into a Live client message, or null when it is not allowed. */
export function toLive(message: Browser): Record<string, unknown> | null {
  switch (message.type) {
    case "audio":
      return typeof message.data === "string" && message.data.length <= 64_000 ? { realtimeInput: { audio: { data: message.data, mimeType: "audio/pcm;rate=16000" } } } : null;
    case "audio_end": return { realtimeInput: { audioStreamEnd: true } };
    case "narrate":
      return typeof message.text === "string" && message.text.length <= 1200 ? { realtimeInput: { text: `${narrationPrefix} ${message.text}` } } : null;
    case "tool_result":
      return typeof message.id === "string" && ["ask_verdant", "stop_analysis"].includes(message.name) && message.response && typeof message.response === "object"
        ? { toolResponse: { functionResponses: [{ id: message.id, name: message.name, response: message.response }] } } : null;
    default: return null;
  }
}

type Part = { inlineData?: { data?: string; mimeType?: string }; text?: string };
type LiveMessage = {
  setupComplete?: unknown; goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  serverContent?: { modelTurn?: { parts?: Part[] }; inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string }; interrupted?: boolean; turnComplete?: boolean };
};
/** Translate one Live server message into the browser messages it produces. */
export function fromLive(message: LiveMessage) {
  const out: Record<string, unknown>[] = [];
  const content = message.serverContent;
  if (message.setupComplete) out.push({ type: "ready" });
  for (const part of content?.modelTurn?.parts ?? []) if (part.inlineData?.data) out.push({ type: "audio", data: part.inlineData.data });
  if (content?.inputTranscription?.text) out.push({ type: "input_transcript", text: content.inputTranscription.text, finished: Boolean(content.inputTranscription.finished) });
  if (content?.outputTranscription?.text) out.push({ type: "output_transcript", text: content.outputTranscription.text });
  if (content?.interrupted) out.push({ type: "interrupted" });
  if (content?.turnComplete) out.push({ type: "turn_complete" });
  if (message.toolCall?.functionCalls?.length) out.push({ type: "tool_call", calls: message.toolCall.functionCalls.map(c => ({ id: c.id, name: c.name, args: c.args ?? {} })) });
  if (message.toolCallCancellation?.ids?.length) out.push({ type: "tool_cancelled", ids: message.toolCallCancellation.ids });
  return out;
}
export type { Browser, LiveMessage };
