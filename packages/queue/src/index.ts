export type QueueLane = "probe" | "data_request" | "acquisition";
export type QueueJob = {
  id: string; kind: QueueLane; payload: unknown;
  status: "queued" | "running" | "completed" | "failed";
  attempts: number; maxAttempts: number; createdAt: number;
  result?: unknown; error?: string;
};
export type ClaimedJob = { job: QueueJob; leaseToken: string };
export type DatabaseRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Server-only transport. Credentials never enter queue payloads or provider errors. */
export function createDatabaseRpc(env: NodeJS.ProcessEnv = process.env): DatabaseRpc {
  const origin = env.SUPABASE_URL, key = env.SUPABASE_SECRET_KEY;
  if (!origin || !key) throw new Error("Supabase server credentials are required.");
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))
    throw new Error("Supabase requires HTTPS outside localhost.");
  return async (name, args) => {
    if (!/^verdant_[a-z_]+$/.test(name)) throw new Error("Invalid RPC name.");
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`, url), {
      method: "POST", headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
        "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) {
      // Supabase SQL error details may contain data; expose only the status/code.
      const error = await response.json().catch(() => ({})) as { code?: string };
      throw new Error(`Database RPC failed (HTTP ${response.status}, code ${error.code ?? "unknown"}).`);
    }
    return response.json();
  };
}
export function queueNamespace(env: NodeJS.ProcessEnv = process.env) {
  if (!["sandbox", "production"].includes(env.VERDANT_ENV ?? "")) throw new Error("VERDANT_ENV must be explicit.");
  if (!["test", "live"].includes(env.PAYMENT_MODE ?? "")) throw new Error("PAYMENT_MODE must be explicit.");
  if (env.VERDANT_ENV === "sandbox" && env.PAYMENT_MODE === "live") throw new Error("Sandbox cannot use live payments.");
  const expected = `verdant:${env.VERDANT_ENV}:${env.PAYMENT_MODE}`;
  if (env.QUEUE_NAMESPACE !== expected) throw new Error("Queue namespace does not match the environment/payment mode.");
  return expected;
}
function leaseSeconds(ms: number) {
  if (!Number.isInteger(ms) || ms < 1000 || ms > 900_000) throw new Error("Invalid lease duration (1–900 seconds).");
  return Math.ceil(ms / 1000);
}
export class JobQueue {
  constructor(private rpc: DatabaseRpc, private namespace: string, private lane: QueueLane) {
    if (!/^verdant:(sandbox:test|production:(test|live))(:smoke)?$/.test(namespace)) throw new Error("Invalid queue namespace.");
  }
  private call(name: string, args: Record<string, unknown> = {}) {
    return this.rpc(name, { p_namespace: this.namespace, p_lane: this.lane, ...args });
  }
  async enqueue(id: string, payload: unknown, fingerprint: string, kind: QueueJob["kind"], maxAttempts = 3): Promise<QueueJob> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid job ID.");
    if (kind !== this.lane) throw new Error("Job kind must match queue lane.");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("Invalid retry budget.");
    if (!fingerprint || fingerprint.length > 256) throw new Error("Invalid fingerprint.");
    const serialized = JSON.stringify(payload);
    if (serialized === undefined || Buffer.byteLength(serialized) > 32_768) throw new Error("Job is too large or invalid; queue references, not files.");
    return await this.call("verdant_enqueue", { p_id: id, p_payload: payload, p_fingerprint: fingerprint, p_max_attempts: maxAttempts }) as QueueJob;
  }
  async claim(leaseMs = 60_000): Promise<ClaimedJob | null> {
    return await this.call("verdant_claim", { p_lease_seconds: leaseSeconds(leaseMs) }) as ClaimedJob | null;
  }
  async get(id: string): Promise<QueueJob | null> {
    return await this.call("verdant_get_job", { p_id: id }) as QueueJob | null;
  }
  async complete(job: ClaimedJob, result: unknown) {
    return await this.call("verdant_finish", { p_id: job.job.id, p_lease_token: job.leaseToken, p_success: true, p_result: result }) === true;
  }
  async fail(job: ClaimedJob, message: string, retryMs = 5_000) {
    if (!Number.isInteger(retryMs) || retryMs < 0 || retryMs > 86_400_000) throw new Error("Invalid retry delay.");
    return await this.call("verdant_finish", { p_id: job.job.id, p_lease_token: job.leaseToken, p_success: false,
      p_error: message.slice(0, 300), p_retry_seconds: Math.ceil(retryMs / 1000) }) === true;
  }
  async renew(job: ClaimedJob, leaseMs = 60_000) {
    return await this.call("verdant_renew", { p_id: job.job.id, p_lease_token: job.leaseToken, p_lease_seconds: leaseSeconds(leaseMs) }) === true;
  }
  async health() {
    const result = await this.call("verdant_queue_health") as { pgmq: boolean; namespace: string };
    if (!result.pgmq) throw new Error("pgmq queue is not provisioned.");
    return result;
  }
}
