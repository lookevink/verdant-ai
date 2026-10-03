import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { playgroundLimits } from "@verdant/contracts/playground";
import { createDatabaseRpc, queueNamespace } from "@verdant/queue";
import { dataResponse } from "./climate-data";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function playgroundRpc() {
  const rpc = createDatabaseRpc(), namespace = queueNamespace();
  return (name: string, args: Record<string, unknown>) => rpc(name, { p_namespace: namespace, ...args });
}
/** Sessions are addressed by a random UUID and authorized by a bearer token; only the token's hash is stored. */
export function sessionAuth(request: Request, id: string) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return sessionId.test(id) && token ? { p_id: id.toLowerCase(), p_token_hash: sha256(token) } : null;
}
/** Rate-limit key per caller address. Salted, so stored hashes do not reveal addresses. */
function clientHash(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
  return sha256(`${process.env.PLAYGROUND_SALT ?? process.env.API_ADMIN_TOKEN ?? ""}:${address}`);
}
/** Each session runs a model, so a deployment can require a shared access code (PLAYGROUND_ACCESS_CODE). */
export function accessAllowed(code: string | undefined) {
  const expected = process.env.PLAYGROUND_ACCESS_CODE;
  return !expected || (code !== undefined && equal(sha256(code), sha256(expected)));
}
export async function createSession(request: Request) {
  const id = randomUUID(), token = randomBytes(32).toString("base64url");
  const session = await playgroundRpc()("verdant_playground_create", { p_id: id, p_token_hash: sha256(token),
    p_client_hash: clientHash(request), p_daily_limit: playgroundLimits.dailySessionsPerClient }) as Record<string, unknown>;
  return session.error ? session : { ...session, token };
}
export const notFound = () => dataResponse({ error: "session_not_found" }, 404);

/**
 * Short-lived ticket for the voice relay (apps/voice), which holds the Vertex credentials. The relay checks the
 * HMAC with the shared PLAYGROUND_VOICE_SECRET, so it serves only live playground sessions, never arbitrary callers.
 */
export function voiceTicket(id: string, ttlSeconds = 120) {
  const secret = process.env.PLAYGROUND_VOICE_SECRET, url = process.env.PLAYGROUND_VOICE_URL;
  if (!secret || secret.length < 32 || !url) return null;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds, body = `${id}.${expires}`;
  return { url, ticket: `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`, expiresAt: new Date(expires * 1000).toISOString() };
}
