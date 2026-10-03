// Deterministic acquisition operations. Pi calls these through narrow tools; the supervisor re-runs the
// checks before publication. All files live in one job directory that only this code writes.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { acquisitionTargetSchema, dateRange, siloGrid, siloLicense, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { decodeWindow, download, listYear, SourceError, sourceKey, sourceUrl } from "./silo";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const jobSchema = z.object({ acquisitionId: z.string().min(1).max(128), attempt: z.number().int().min(1), target: acquisitionTargetSchema });
export type JobFile = z.infer<typeof jobSchema>;
const receiptSchema = z.object({ date: z.iso.date(), url: z.url(), key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(), etag: z.string().nullable(), lastModified: z.string().nullable(), fetchedAt: z.string() });
export type Receipt = z.infer<typeof receiptSchema>;
export type Check = { name: string; passed: boolean; detail: string };
export type ValidationReport = { passed: boolean; checks: Check[]; warnings: string[]; fingerprint: string; validatedAt: string };

export class Workspace {
  private constructor(readonly dir: string, readonly job: JobFile) {}
  static async create(dir: string, job: JobFile) {
    await mkdir(path.join(dir, "sources"), { recursive: true });
    await mkdir(path.join(dir, "normalized"), { recursive: true });
    await writeFile(path.join(dir, "job.json"), JSON.stringify(jobSchema.parse(job), null, 2));
    return new Workspace(dir, job);
  }
  static async open(dir: string) {
    return new Workspace(dir, jobSchema.parse(JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"))));
  }
  get target(): AcquisitionTarget { return this.job.target; }
  dates() { return dateRange(this.target.period.start, this.target.period.end); }
  file(...parts: string[]) { return path.join(this.dir, ...parts); }
  async readJson<T>(...parts: string[]): Promise<T | null> {
    try { return JSON.parse(await readFile(this.file(...parts), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async writeJson(value: unknown, ...parts: string[]) { await writeFile(this.file(...parts), JSON.stringify(value)); }
  /** Permanent problems are recorded for the supervisor, which ends the job without retries. */
  async recordPermanentFailure(reason: string) { await this.writeJson({ reason, recordedAt: new Date().toISOString() }, "permanent-failure.json"); }
  async receipt(date: string) {
    const value = await this.readJson<unknown>("sources", `${date}.json`);
    return value === null ? null : receiptSchema.parse(value);
  }
  requireTargetDates(dates: string[]) {
    const allowed = new Set(this.dates());
    const outside = dates.filter(d => !allowed.has(d));
    if (outside.length) throw new Error(`Dates outside the target period: ${outside.join(", ")}. Only ${this.target.period.start}..${this.target.period.end} may be acquired.`);
    return [...new Set(dates)].sort();
  }
}

export function describeTarget(ws: Workspace) {
  const t = ws.target;
  return { provider: "SILO (Queensland Government)", product: "Official daily gridded surfaces (GeoTIFF)", license: siloLicense.license,
    variable: t.variable, sourceVariable: t.sourceVariable, unit: t.unit, period: t.period, days: ws.dates().length,
    grid: { crs: "EPSG:4326", resolutionDegrees: siloGrid.resolution, width: siloGrid.width, height: siloGrid.height },
    window: t.window, bounds: t.bbox };
}

export async function inspectSource(ws: Workspace, signal?: AbortSignal) {
  const dates = ws.dates(), years = [...new Set(dates.map(d => d.slice(0, 4)))];
  const listings = new Map<string, Awaited<ReturnType<typeof listYear>>>();
  for (const year of years) listings.set(year, await listYear(ws.target.sourceVariable, year, signal));
  const availability = dates.map(date => {
    const object = listings.get(date.slice(0, 4))!.get(date);
    return object && object.key === sourceKey(ws.target.sourceVariable, date)
      ? { date, available: true, bytes: object.bytes, lastModified: object.lastModified } : { date, available: false };
  });
  const missing = availability.filter(a => !a.available).map(a => a.date);
  // A missing day older than a week will not appear on retry; newer days may still be pending upload.
  const stale = missing.filter(d => Date.parse(d) < Date.now() - 7 * 86_400_000);
  if (stale.length) await ws.recordPermanentFailure(`source_date_unavailable: ${stale.join(", ")}`);
  await ws.writeJson({ availability, inspectedAt: new Date().toISOString() }, "inspection.json");
  return { target: describeTarget(ws), available: dates.length - missing.length, missing,
    totalBytes: availability.reduce((sum, a) => sum + (a.bytes ?? 0), 0) };
}

export async function fetchSource(ws: Workspace, requested: string[], signal?: AbortSignal) {
  const dates = ws.requireTargetDates(requested);
  const results = [];
  for (const date of dates) {
    const existing = await ws.receipt(date);
    if (existing) {
      const body = await readFile(ws.file("sources", `${date}.tif`)).catch(() => null);
      if (body && sha256(body) === existing.sha256) { results.push({ date, status: "cached", bytes: existing.bytes, sha256: existing.sha256 }); continue; }
    }
    try {
      const object = await download(ws.target.sourceVariable, date, signal);
      await writeFile(ws.file("sources", `${date}.tif`), object.body);
      const receipt: Receipt = { date, url: object.url, key: object.key, sha256: object.sha256, bytes: object.bytes,
        etag: object.etag, lastModified: object.lastModified, fetchedAt: new Date().toISOString() };
      await ws.writeJson(receipt, "sources", `${date}.json`);
      results.push({ date, status: "downloaded", bytes: object.bytes, sha256: object.sha256 });
    } catch (error) {
      if (signal?.aborted) throw error;
      results.push({ date, status: "failed", error: (error as Error).message, permanent: error instanceof SourceError && error.permanent });
    }
  }
  return { results, failed: results.filter(r => r.status === "failed").map(r => r.date) };
}

type Normalized = { date: string; sourceSha256: string; window: AcquisitionTarget["window"]; cells: (number | null)[];
  stats: Awaited<ReturnType<typeof decodeWindow>>["stats"]; tags: Record<string, string> };
async function decodeDate(ws: Workspace, date: string) {
  const receipt = await ws.receipt(date);
  if (!receipt) throw new Error(`No source fetched for ${date}; call fetch_source first.`);
  const body = await readFile(ws.file("sources", `${date}.tif`));
  if (sha256(body) !== receipt.sha256) throw new Error(`Source file for ${date} does not match its receipt; fetch it again.`);
  try {
    const decoded = await decodeWindow(body, ws.target);
    return { date, sourceSha256: receipt.sha256, window: ws.target.window, ...decoded } satisfies Normalized;
  } catch (error) {
    if (error instanceof SourceError && error.permanent) await ws.recordPermanentFailure(`source_format_changed: ${error.message}`);
    throw error;
  }
}

export async function normalizeSource(ws: Workspace, requested?: string[]) {
  const dates = ws.requireTargetDates(requested?.length ? requested : ws.dates());
  const results = [];
  for (const date of dates) {
    try {
      const normalized = await decodeDate(ws, date);
      await ws.writeJson(normalized, "normalized", `${date}.json`);
      results.push({ date, status: "normalized", ...normalized.stats });
    } catch (error) { results.push({ date, status: "failed", error: (error as Error).message }); }
  }
  return { window: ws.target.window, results, failed: results.filter(r => r.status === "failed").map(r => r.date) };
}

/** Re-decodes every source file and compares every normalized cell. Never modifies data. */
export async function validateOutput(ws: Workspace): Promise<ValidationReport> {
  const checks: Check[] = [], warnings: string[] = [];
  const check = (name: string, passed: boolean, detail: string) => { checks.push({ name, passed, detail }); return passed; };
  const { width, height } = ws.target.window, dates = ws.dates();
  const parts: string[] = [];
  let fetched = 0, provenance = 0, decoded = 0, reconciled = 0, shaped = 0, plausible = 0, finite = 0, missing = 0, cells = 0;
  const problems: string[] = [];
  for (const date of dates) {
    const receipt = await ws.receipt(date);
    if (!receipt) { problems.push(`${date}: not fetched`); continue; }
    fetched++;
    if (receipt.url === sourceUrl(ws.target.sourceVariable, date) && receipt.key === sourceKey(ws.target.sourceVariable, date)) provenance++;
    else problems.push(`${date}: receipt is not the canonical source object`);
    const stored = await ws.readJson<Normalized>("normalized", `${date}.json`);
    if (!stored) { problems.push(`${date}: not normalized`); continue; }
    let fresh: Normalized;
    try { fresh = await decodeDate(ws, date); decoded++; } catch (error) { problems.push(`${date}: ${(error as Error).message}`); continue; }
    const freshText = JSON.stringify(fresh.cells);
    if (stored.sourceSha256 === receipt.sha256 && JSON.stringify(stored.cells) === freshText && JSON.stringify(stored.window) === JSON.stringify(ws.target.window)) reconciled++;
    else problems.push(`${date}: normalized output does not reproduce from the source; normalize again`);
    if (fresh.cells.length === width * height) shaped++;
    if (fresh.stats.nonFinite === 0) finite++; else problems.push(`${date}: ${fresh.stats.nonFinite} non-finite cells`);
    if (fresh.stats.implausible === 0) plausible++; else problems.push(`${date}: ${fresh.stats.implausible} values outside the plausible range`);
    missing += fresh.stats.missing; cells += fresh.cells.length;
    parts.push(`${date}:${receipt.sha256}:${sha256(freshText)}`);
  }
  check("period_complete", fetched === dates.length, `${fetched}/${dates.length} target dates fetched`);
  check("source_provenance", provenance === dates.length, `${provenance}/${dates.length} receipts point at the canonical SILO object`);
  check("source_to_output_reconciliation", reconciled === dates.length, `${reconciled}/${dates.length} days reproduce cell-for-cell from verified source bytes`);
  check("dimensions", shaped === dates.length, `${shaped}/${dates.length} days have ${width}×${height} cells`);
  check("finite_values", finite === dates.length, "NaN/Infinity are rejected; source nodata becomes null, never zero");
  check("nodata_mask", decoded === dates.length, `${decoded}/${dates.length} source files have exactly the ${siloGrid.oceanCells}-cell SILO ocean mask as nodata`);
  check("plausible_range", plausible === dates.length, `${ws.target.variable} within the declared plausible range`);
  if (cells && missing === cells) warnings.push("Every cell is missing at the source (for example open ocean). Missing values are preserved as null.");
  else if (missing) warnings.push(`${missing} of ${cells} cells are missing at the source and preserved as null.`);
  const report: ValidationReport = { passed: checks.every(c => c.passed), checks, warnings, fingerprint: sha256(parts.join("\n")), validatedAt: new Date().toISOString() };
  if (problems.length) report.warnings.push(...problems.slice(0, 20));
  await ws.writeJson(report, "validation.json");
  return report;
}

export async function submitManifest(ws: Workspace, summary: string) {
  const report = await ws.readJson<ValidationReport>("validation.json");
  if (!report?.passed) throw new Error("validate_output has not passed. Repair the failing checks and validate again before submitting.");
  const current = await validateOutput(ws);
  if (!current.passed || current.fingerprint !== report.fingerprint) throw new Error("Files changed since the last validation; run validate_output again.");
  const sources = await Promise.all(ws.dates().map(async d => (await ws.receipt(d))!));
  const manifest = { acquisitionId: ws.job.acquisitionId, attempt: ws.job.attempt, target: ws.target, sources,
    validation: { fingerprint: current.fingerprint, checks: current.checks.map(c => c.name), warnings: current.warnings },
    summary: summary.slice(0, 1000), submittedAt: new Date().toISOString() };
  await ws.writeJson(manifest, "manifest.json");
  return { submitted: true, days: sources.length, fingerprint: current.fingerprint };
}

/** Remove downloaded source bytes; receipts, manifest and validation remain for inspection. */
export async function pruneSources(ws: Workspace) {
  await Promise.all(ws.dates().map(d => rm(ws.file("sources", `${d}.tif`), { force: true })));
}
export { sha256 };
