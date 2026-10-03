import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AcquisitionTarget } from "@verdant/contracts/acquisition";

/** Thrown for source problems. Permanent errors cannot be fixed by retrying the job. */
export class SourceError extends Error {
  constructor(message: string, readonly permanent = false) { super(message); }
}
/** One downloadable source object (a file, or a server-side subset) and the target dates it holds. */
export type SourceObject = { id: string; url: string; key: string; dates: string[];
  /** Equally canonical fallbacks, tried in order (e.g. a preliminary file before the final one exists). */
  alternates?: { url: string; key: string }[] };
export type Availability = { date: string; available: boolean; bytes?: number; lastModified?: string };
export type Downloaded = { body: Buffer; etag: string | null; lastModified: string | null; url?: string; key?: string };
/** Verified access to stored source objects: bytes, or a local file path for decoders that open files. */
export type SourceFiles = { read(object: SourceObject): Promise<Buffer>; path(object: SourceObject): Promise<string> };
export type DecodedDay = { cells: (number | null)[]; tags: Record<string, string>; notes: Record<string, string | number> };

export interface SourceAdapter {
  /** Deterministic list of source objects that together hold every target date. */
  objects(target: AcquisitionTarget): SourceObject[];
  /** Read-only availability of each target date at the source. */
  inspect(target: AcquisitionTarget, signal?: AbortSignal): Promise<Availability[]>;
  download(object: SourceObject, signal?: AbortSignal): Promise<Downloaded>;
  /** Decode one date's target window from the stored bytes of its objects. Georeference drift is permanent. */
  decode(target: AcquisitionTarget, date: string, files: SourceFiles): Promise<DecodedDay>;
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** HTTPS GET restricted to one host and path prefix, without redirects, size-bounded, with bounded retries. */
export async function boundedGet(url: URL, allowed: { host: string; pathPrefix: string }, maxBytes: number, signal?: AbortSignal) {
  if (url.protocol !== "https:" || url.host !== allowed.host || !url.pathname.startsWith(allowed.pathPrefix))
    throw new SourceError("Source URL is outside the allowed source.", true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) });
      if (response.status === 404 || response.status === 403) throw new SourceError(`Source object not found (HTTP ${response.status}).`, true);
      if (response.status === 400) throw new SourceError("Source rejected the request (HTTP 400).", true);
      if (!response.ok) throw new SourceError(`Source returned HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new SourceError("Source object exceeds the size limit.", true);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new SourceError("Source object exceeds the size limit.", true);
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), etag: response.headers.get("etag")?.replaceAll('"', "") ?? null, lastModified: response.headers.get("last-modified") };
    } catch (error) {
      if ((error instanceof SourceError && error.permanent) || signal?.aborted) throw error;
      lastError = error;
      if (attempt < 3) await delay(1000 * attempt * attempt, undefined, { signal });
    }
  }
  throw lastError instanceof SourceError ? lastError : new SourceError(`Source request failed: ${(lastError as Error)?.message ?? "unknown"}`);
}

/** Shortest decimal that round-trips to the same float32, matching Postgres real output. */
export function float32(value: number) {
  const exact = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(exact.toPrecision(digits));
    if (Math.fround(candidate) === exact) return candidate;
  }
  return exact;
}
export const yearsOf = (dates: string[]) => [...new Set(dates.map(d => d.slice(0, 4)))];
