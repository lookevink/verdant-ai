import type { PlaygroundEvent } from "@verdant/contracts/playground";

export type Session = { id: string; token: string };
type Status = { status: string; lastSeq: number };
const storageKey = "verdant.playground.session";
const base = "/api/v1/playground/sessions";

export class PlaygroundError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
async function call<T>(path: string, session: Session | null, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok || result.error) throw new PlaygroundError(result.error ?? "unavailable", response.status);
  return result;
}

export const createSession = (accessCode?: string) => call<Session>(base, null, accessCode ? { accessCode } : {});
export const sendMessage = (session: Session, text: string, source: "text" | "voice" = "text") =>
  call<{ seq: number }>(`${base}/${session.id}/messages`, session, { text, source });
export const cancelTurn = (session: Session) => call<Status>(`${base}/${session.id}/cancel`, session);
export const voiceTicket = (session: Session) => call<{ url: string; ticket: string; expiresAt: string }>(`${base}/${session.id}/voice`, session);

/** The session survives reloads in this browser only; its token never leaves this origin. */
export function savedSession(): Session | null {
  try { const value = JSON.parse(localStorage.getItem(storageKey) ?? "null"); return value?.id && value?.token ? value : null; } catch { return null; }
}
export function saveSession(session: Session | null) {
  try { if (session) localStorage.setItem(storageKey, JSON.stringify(session)); else localStorage.removeItem(storageKey); } catch { /* storage unavailable */ }
}

/**
 * Follow the session's event log over SSE, read with fetch so the token stays in a header. The server ends each stream
 * after a few minutes; this reconnects from the last sequence number until `signal` aborts.
 */
export async function followEvents(session: Session, handlers: { event(e: PlaygroundEvent): void; status(s: Status): void; lost(): void }, signal: AbortSignal) {
  let after = 0, failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/${session.id}/events?after=${after}`, { signal, cache: "no-store",
        headers: { Authorization: `Bearer ${session.token}`, Accept: "text/event-stream" } });
      if (response.status === 404) return handlers.lost();
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      failures = 0;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          let name = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) name = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          if (name === "session") handlers.status(JSON.parse(data));
          else { const event = JSON.parse(data) as PlaygroundEvent; after = Math.max(after, event.seq); handlers.event(event); }
        }
      }
    } catch { if (signal.aborted) return; failures++; }
    await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** failures, 8000)));
  }
}
