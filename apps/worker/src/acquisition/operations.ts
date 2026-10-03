// Deterministic acquisition operations. Pi calls these through narrow tools; the supervisor re-runs the
// checks before publication. All files live in one job directory that only this code writes.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { acquisitionTargetSchema, dateRange, sourceSpecs, type AcquirableSource, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { adapterFor } from "./sources";
import { sha256, SourceError, type DecodedDay, type SourceObject } from "./sources/types";

const jobSchema = z.object({ acquisitionId: z.string().min(1).max(128), attempt: z.number().int().min(1), target: acquisitionTargetSchema });
export type JobFile = z.infer<typeof jobSchema>;
const receiptSchema = z.object({ object: z.string(), dates: z.array(z.iso.date()), url: z.url(), key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(), etag: z.string().nullable(), lastModified: z.string().nullable(), fetchedAt: z.string() });
export type Receipt = z.infer<typeof receiptSchema>;
export type Check = { name: string; passed: boolean; detail: string };
export type ValidationReport = { passed: boolean; checks: Check[]; warnings: string[]; fingerprint: string; validatedAt: string };
type Stats = { cells: number; missing: number; min: number | null; max: number | null; implausible: number; nonFinite: number };
export type Normalized = DecodedDay & { date: string; sources: string[]; window: AcquisitionTarget["window"]; stats: Stats };

const fileId = (object: SourceObject) => object.id.replace(/[^A-Za-z0-9._-]/g, "_");
export class Workspace {
  private readonly verified = new Map<string, string>();
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
  get adapter() { return adapterFor(this.target.source); }
  get spec() { return sourceSpecs[this.target.source as AcquirableSource]; }
  dates() { return dateRange(this.target.period.start, this.target.period.end); }
  objects() { return this.adapter.objects(this.target); }
  objectsFor(date: string) { return this.objects().filter(o => o.dates.includes(date)); }
  file(...parts: string[]) { return path.join(this.dir, ...parts); }
  async readJson<T>(...parts: string[]): Promise<T | null> {
    try { return JSON.parse(await readFile(this.file(...parts), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async writeJson(value: unknown, ...parts: string[]) { await writeFile(this.file(...parts), JSON.stringify(value)); }
  /** Permanent problems are recorded for the supervisor, which ends the job without retries. */
  async recordPermanentFailure(reason: string) { await this.writeJson({ reason, recordedAt: new Date().toISOString() }, "permanent-failure.json"); }
  async receipt(object: SourceObject) {
    const value = await this.readJson<unknown>("sources", `${fileId(object)}.json`);
    return value === null ? null : receiptSchema.parse(value);
  }
  /** Path of a stored source object, verified against the receipt written when it was downloaded. */
  async sourceFile(object: SourceObject) {
    const receipt = await this.receipt(object);
    if (!receipt) throw new Error(`Source object ${object.id} has not been fetched; call fetch_source first.`);
    const file = this.file("sources", `${fileId(object)}.bin`);
    const info = await stat(file).catch(() => null);
    if (!info) throw new Error(`Source object ${object.id} is missing; fetch it again.`);
    // Large monthly files are decoded once per day; re-hash only if the file changed since it was last verified.
    const stamp = `${receipt.sha256}:${info.size}:${info.mtimeMs}`;
    if (this.verified.get(object.id) !== stamp) {
      if (sha256(await readFile(file)) !== receipt.sha256) throw new Error(`Source object ${object.id} does not match its receipt; fetch it again.`);
      this.verified.set(object.id, stamp);
    }
    return file;
  }
  async sourceBytes(object: SourceObject) { return readFile(await this.sourceFile(object)); }
  sourceFiles() { return { read: (o: SourceObject) => this.sourceBytes(o), path: (o: SourceObject) => this.sourceFile(o) }; }
  requireTargetDates(dates: string[]) {
    const allowed = new Set(this.dates());
    const outside = dates.filter(d => !allowed.has(d));
    if (outside.length) throw new Error(`Dates outside the target period: ${outside.join(", ")}. Only ${this.target.period.start}..${this.target.period.end} may be acquired.`);
    return [...new Set(dates)].sort();
  }
}

export function describeTarget(ws: Workspace) {
  const t = ws.target, spec = ws.spec;
  return { provider: `${spec.title} (${spec.provider})`, product: spec.product, license: spec.license,
    variable: t.variable, sourceVariable: t.sourceVariable, unit: t.unit, period: t.period, days: ws.dates().length,
    grid: { crs: "EPSG:4326", resolutionDegrees: spec.grid.resolution, width: spec.grid.width, height: spec.grid.height },
    window: t.window, bounds: t.bbox, sourceObjects: ws.objects().length };
}

export async function inspectSource(ws: Workspace, signal?: AbortSignal) {
  const availability = await ws.adapter.inspect(ws.target, signal);
  const missing = availability.filter(a => !a.available).map(a => a.date);
  // A missing day older than a week will not appear on retry; newer days may still be pending upload.
  const stale = missing.filter(d => Date.parse(d) < Date.now() - 7 * 86_400_000);
  if (stale.length) await ws.recordPermanentFailure(`source_date_unavailable: ${stale.join(", ")}`);
  await ws.writeJson({ availability, inspectedAt: new Date().toISOString() }, "inspection.json");
  return { target: describeTarget(ws), available: availability.length - missing.length, missing,
    totalBytes: availability.reduce((sum, a) => sum + (a.bytes ?? 0), 0) };
}

export async function fetchSource(ws: Workspace, requested: string[], signal?: AbortSignal) {
  const dates = new Set(ws.requireTargetDates(requested));
  const results = [];
  for (const object of ws.objects().filter(o => o.dates.some(d => dates.has(d)))) {
    const cached = await ws.sourceBytes(object).then(() => true, () => false);
    if (cached) { const r = (await ws.receipt(object))!; results.push({ object: object.id, dates: object.dates, status: "cached", bytes: r.bytes }); continue; }
    try {
      const downloaded = await ws.adapter.download(object, signal);
      await writeFile(ws.file("sources", `${fileId(object)}.bin`), downloaded.body);
      const receipt: Receipt = { object: object.id, dates: object.dates, url: downloaded.url ?? object.url, key: downloaded.key ?? object.key, sha256: sha256(downloaded.body),
        bytes: downloaded.body.byteLength, etag: downloaded.etag, lastModified: downloaded.lastModified, fetchedAt: new Date().toISOString() };
      await ws.writeJson(receipt, "sources", `${fileId(object)}.json`);
      results.push({ object: object.id, dates: object.dates, status: "downloaded", bytes: receipt.bytes, sha256: receipt.sha256 });
    } catch (error) {
      if (signal?.aborted) throw error;
      results.push({ object: object.id, dates: object.dates, status: "failed", error: (error as Error).message, permanent: error instanceof SourceError && error.permanent });
    }
  }
  return { results, failed: results.filter(r => r.status === "failed").flatMap(r => r.dates) };
}

function summarize(cells: (number | null)[], plausible: readonly [number, number]): Stats {
  let min = Infinity, max = -Infinity, missing = 0, implausible = 0, nonFinite = 0;
  for (const v of cells) {
    if (v === null) { missing++; continue; }
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    if (v < plausible[0] || v > plausible[1]) implausible++;
    min = Math.min(min, v); max = Math.max(max, v);
  }
  const empty = missing === cells.length;
  return { cells: cells.length, missing, min: empty ? null : min, max: empty ? null : max, implausible, nonFinite };
}
async function decodeDate(ws: Workspace, date: string): Promise<Normalized> {
  try {
    const decoded = await ws.adapter.decode(ws.target, date, ws.sourceFiles());
    const plausible = ws.spec.variables[ws.target.variable as keyof typeof ws.spec.variables]!.plausible;
    const sources = await Promise.all(ws.objectsFor(date).map(async o => (await ws.receipt(o))!.sha256));
    return { date, sources, window: ws.target.window, ...decoded, stats: summarize(decoded.cells, plausible) };
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

/** Re-decodes every day from verified source bytes and compares every normalized cell. Never modifies data. */
export async function validateOutput(ws: Workspace): Promise<ValidationReport> {
  const checks: Check[] = [], warnings: string[] = [], problems: string[] = [];
  const check = (name: string, passed: boolean, detail: string) => { checks.push({ name, passed, detail }); return passed; };
  const { width, height } = ws.target.window, dates = ws.dates(), objects = ws.objects(), parts: string[] = [];
  let fetched = 0, provenance = 0, decoded = 0, reconciled = 0, shaped = 0, plausible = 0, finite = 0, missing = 0, cells = 0;
  for (const object of objects) {
    const receipt = await ws.receipt(object);
    if (!receipt) { problems.push(`${object.id}: not fetched`); continue; }
    fetched++;
    const canonical = [{ url: object.url, key: object.key }, ...(object.alternates ?? [])].some(c => c.url === receipt.url && c.key === receipt.key);
    if (canonical && JSON.stringify(receipt.dates) === JSON.stringify(object.dates)) provenance++;
    else problems.push(`${object.id}: receipt is not the canonical source object`);
  }
  for (const date of dates) {
    const stored = await ws.readJson<Normalized>("normalized", `${date}.json`);
    if (!stored) { problems.push(`${date}: not normalized`); continue; }
    let fresh: Normalized;
    try { fresh = await decodeDate(ws, date); decoded++; } catch (error) { problems.push(`${date}: ${(error as Error).message}`); continue; }
    const freshText = JSON.stringify(fresh.cells);
    if (JSON.stringify(stored.sources) === JSON.stringify(fresh.sources) && JSON.stringify(stored.cells) === freshText
      && JSON.stringify(stored.window) === JSON.stringify(ws.target.window)) reconciled++;
    else problems.push(`${date}: normalized output does not reproduce from the source; normalize again`);
    if (fresh.cells.length === width * height) shaped++;
    if (fresh.stats.nonFinite === 0) finite++; else problems.push(`${date}: ${fresh.stats.nonFinite} non-finite cells`);
    if (fresh.stats.implausible === 0) plausible++; else problems.push(`${date}: ${fresh.stats.implausible} values outside the plausible range`);
    missing += fresh.stats.missing; cells += fresh.cells.length;
    parts.push(`${date}:${fresh.sources.join("+")}:${sha256(freshText)}`);
  }
  check("source_objects_complete", fetched === objects.length, `${fetched}/${objects.length} source objects fetched for ${dates.length} target dates`);
  check("source_provenance", provenance === objects.length, `${provenance}/${objects.length} receipts match the canonical ${ws.spec.title} request`);
  check("source_format", decoded === dates.length, `${decoded}/${dates.length} days decode with the expected grid, coordinates and nodata encoding`);
  check("source_to_output_reconciliation", reconciled === dates.length, `${reconciled}/${dates.length} days reproduce cell-for-cell from verified source bytes`);
  check("dimensions", shaped === dates.length, `${shaped}/${dates.length} days have ${width}×${height} cells`);
  check("finite_values", finite === dates.length, "NaN/Infinity are rejected; source nodata becomes null, never zero");
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
  const sources = await Promise.all(ws.objects().map(async o => (await ws.receipt(o))!));
  const manifest = { acquisitionId: ws.job.acquisitionId, attempt: ws.job.attempt, target: ws.target, sources,
    validation: { fingerprint: current.fingerprint, checks: current.checks.map(c => c.name), warnings: current.warnings },
    summary: summary.slice(0, 1000), submittedAt: new Date().toISOString() };
  await ws.writeJson(manifest, "manifest.json");
  return { submitted: true, days: ws.dates().length, sourceObjects: sources.length, fingerprint: current.fingerprint };
}

/** Remove downloaded source bytes; receipts, manifest and validation remain for inspection. */
export async function pruneSources(ws: Workspace) {
  await Promise.all(ws.objects().map(o => rm(ws.file("sources", `${fileId(o)}.bin`), { force: true })));
}
export { sha256 };
