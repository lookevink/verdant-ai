// Voice relay for the playground sprout. Vertex AI's Live API authenticates server to server only (no ephemeral
// browser tokens), so this process holds the Vertex credentials and bridges each browser WebSocket to one Gemini Live
// session. A browser must first present a short-lived ticket the API signed for a live playground session.
//   PLAYGROUND_VOICE_SECRET   shared with the API (≥32 chars)
//   GOOGLE_APPLICATION_CREDENTIALS or VERTEX_CREDENTIALS_FILE   service-account JSON (default: ../../vertex-service-account.json)
//   VERTEX_PROJECT (default: the service account's project), VERTEX_LOCATION (us-central1), VOICE_MODEL, VOICE_NAME, VOICE_PORT (3004)
//   VOICE_ALLOWED_ORIGINS   comma-separated browser origins (default: local web and verdant-ai.com)
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { fromLive, liveUrl, setupMessage, toLive, verifyTicket, type Browser, type LiveConfig, type LiveMessage } from "./live";

// Direct invocations default to sandbox; scripts/run-profile.mjs selects a profile explicitly.
try { if (!process.env.VERDANT_PROFILE_LOADED) process.loadEnvFile(".env.local"); } catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const log = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...details, timestamp: new Date().toISOString() }));
const secret = process.env.PLAYGROUND_VOICE_SECRET ?? "";
if (secret.length < 32) throw new Error("PLAYGROUND_VOICE_SECRET must be at least 32 characters and match the API.");
const keyFile = process.env.VERTEX_CREDENTIALS_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
  ?? [path.resolve(import.meta.dirname, "../../../vertex-service-account.json")].find(existsSync);
const project = process.env.VERTEX_PROJECT ?? (keyFile ? (JSON.parse(readFileSync(keyFile, "utf8")) as { project_id?: string }).project_id : undefined);
if (!project) throw new Error("Set VERTEX_PROJECT or provide a service-account file.");
const config: LiveConfig = { project, location: process.env.VERTEX_LOCATION ?? "us-central1",
  model: process.env.VOICE_MODEL ?? "gemini-3.8-live", voice: process.env.VOICE_NAME ?? "Leda" };
const origins = (process.env.VOICE_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000,https://verdant-ai.com,https://www.verdant-ai.com").split(",");
const auth = new GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const maxConnections = Number(process.env.VOICE_MAX_CONNECTIONS) || 20, maxMinutes = Number(process.env.VOICE_MAX_MINUTES) || 30;
const bySession = new Map<string, WebSocket>();

const server = createServer((request, response) => {
  if (request.url === "/health") return void response.writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ ok: true, model: config.model, location: config.location, connections: bySession.size }));
  response.writeHead(404).end();
});
const wss = new WebSocketServer({ server, path: "/live", maxPayload: 256 * 1024,
  verifyClient: ({ origin }: { origin?: string }) => !origin || origins.includes(origin) });

wss.on("connection", browser => {
  const send = (message: Record<string, unknown>) => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(message)); };
  let upstream: WebSocket | null = null, session: string | null = null, handle: string | undefined, closing = false;
  const queued: string[] = [];
  const close = (reason: string) => {
    if (closing) return;
    closing = true;
    send({ type: "closing", reason });
    upstream?.close(); browser.close();
    if (session && bySession.get(session) === browser) bySession.delete(session);
    log("voice_closed", { session, reason });
  };
  const helloTimer = setTimeout(() => close("hello_timeout"), 10_000);
  const lifetime = setTimeout(() => close("session_time_limit"), maxMinutes * 60_000);
  browser.on("close", () => { clearTimeout(helloTimer); clearTimeout(lifetime); close("browser_closed"); });

  // Opens (or, after goAway, resumes) the Live session. Browser messages wait until setup completes.
  const connect = async () => {
    const token = (await auth.getAccessToken()) ?? "";
    const live = new WebSocket(liveUrl(config.location), { headers: { Authorization: `Bearer ${token}` } });
    upstream = live;
    let ready = false;
    live.on("open", () => live.send(JSON.stringify(setupMessage(config, handle))));
    live.on("message", (data: RawData) => {
      let message: LiveMessage & { goAway?: unknown };
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) handle = message.sessionResumptionUpdate.newHandle;
      if (message.setupComplete && !ready) {
        ready = true;
        for (const item of queued.splice(0)) live.send(item);
        if (handle) return; // A resumed connection is invisible to the browser.
      }
      if (message.goAway) { log("voice_go_away", { session, timeLeft: message.goAway.timeLeft }); void reconnect(live); return; }
      for (const out of fromLive(message)) send(out);
    });
    live.on("close", (code, reason) => {
      if (upstream === live && !closing) close(`upstream_closed_${code}${reason.length ? `: ${reason.toString().slice(0, 120)}` : ""}`);
    });
    live.on("error", error => log("voice_upstream_error", { session, message: error.message.slice(0, 200) }));
    return () => ready;
  };
  let isReady: () => boolean = () => false;
  const reconnect = async (old: WebSocket) => {
    if (closing || !handle) return close("go_away_without_handle");
    upstream = null;
    old.close();
    try { isReady = await connect(); } catch { close("reconnect_failed"); }
  };

  browser.on("message", async (data: RawData) => {
    let message: Browser;
    try { message = JSON.parse(data.toString()); } catch { return close("invalid_message"); }
    if (!session) {
      const ticket = message.type === "hello" ? verifyTicket(message.ticket, secret) : null;
      if (!ticket) return close("invalid_ticket");
      if (bySession.size >= maxConnections && !bySession.has(ticket.session)) return close("relay_busy");
      clearTimeout(helloTimer);
      session = ticket.session;
      bySession.get(session)?.close(); // One voice connection per playground session.
      bySession.set(session, browser);
      log("voice_opened", { session, model: config.model });
      try { isReady = await connect(); } catch (error) { log("voice_auth_failed", { message: (error as Error).message.slice(0, 200) }); close("vertex_unavailable"); }
      return;
    }
    const live = toLive(message);
    if (!live) return;
    const text = JSON.stringify(live);
    if (upstream && isReady() && upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else if (queued.length < 200) queued.push(text);
  });
});

const port = Number(process.env.VOICE_PORT) || 3004;
server.listen(port, "127.0.0.1", () => log("voice_listening", { url: `ws://127.0.0.1:${port}/live`, model: config.model, location: config.location, voice: config.voice }));
