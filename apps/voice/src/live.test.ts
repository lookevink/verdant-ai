import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { fromLive, liveUrl, narrationPrefix, setupMessage, toLive, verifyTicket } from "./live";

const secret = "s".repeat(40), session = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ticket = (expires: number, key = secret) => `${session}.${expires}.${createHmac("sha256", key).update(`${session}.${expires}`).digest("base64url")}`;

test("tickets are bound to a session, signed with the shared secret and expire", () => {
  const future = Math.floor(Date.now() / 1000) + 60;
  assert.equal(verifyTicket(ticket(future), secret)?.session, session);
  assert.equal(verifyTicket(ticket(future, "t".repeat(40)), secret), null);
  assert.equal(verifyTicket(ticket(Math.floor(Date.now() / 1000) - 1), secret), null);
  assert.equal(verifyTicket(ticket(future).replace(session, "1f8fad5b-d9cb-469f-a165-70867728950e"), secret), null);
  assert.equal(verifyTicket(42, secret), null);
});

test("browsers can send audio, narration and tool results, but not their own setup or prompts", () => {
  assert.deepEqual(toLive({ type: "audio", data: "AAAA" }), { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } });
  assert.deepEqual(toLive({ type: "narrate", text: "It was 41.2 degrees." }), { realtimeInput: { text: `${narrationPrefix} It was 41.2 degrees.` } });
  assert.equal(toLive({ type: "narrate", text: "x".repeat(1201) }), null);
  assert.equal(toLive({ type: "tool_result", id: "1", name: "anything_else", response: {} }), null);
  assert.equal(toLive({ type: "setup", setup: {} } as never), null);
  assert.equal(toLive({ type: "client_content", turns: [] } as never), null);
});

test("Live server messages become compact browser messages", () => {
  assert.deepEqual(fromLive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "PCM" } }] }, outputTranscription: { text: "Hi" }, turnComplete: true } }),
    [{ type: "audio", data: "PCM" }, { type: "output_transcript", text: "Hi" }, { type: "turn_complete" }]);
  assert.deepEqual(fromLive({ toolCall: { functionCalls: [{ id: "c1", name: "ask_verdant", args: { question: "q" } }] } }),
    [{ type: "tool_call", calls: [{ id: "c1", name: "ask_verdant", args: { question: "q" } }] }]);
});

test("setup pins the model, voice, tools and transcription on Vertex", () => {
  const { setup } = setupMessage({ project: "p", location: "us-central1", model: "gemini-3.8-live", voice: "Leda" });
  assert.equal(setup.model, "projects/p/locations/us-central1/publishers/google/models/gemini-3.8-live");
  assert.deepEqual(setup.tools[0]!.functionDeclarations.map(f => f.name), ["ask_verdant", "stop_analysis"]);
  assert.equal(liveUrl("us-central1"), "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent");
  assert.equal(liveUrl("us"), "wss://aiplatform.us.rep.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent");
});
