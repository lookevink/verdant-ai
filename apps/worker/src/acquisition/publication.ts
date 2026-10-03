import { sourceSpecs, type AcquirableSource } from "@verdant/contracts/acquisition";
import { sha256, validateOutput, type Normalized, type Receipt, type Workspace } from "./operations";

export class VerificationError extends Error {}
const shortName: Record<string, string> = { air_temperature_max: "tmax", air_temperature_min: "tmin", precipitation_amount: "precip" };
const titles: Record<string, string> = { air_temperature_max: "daily maximum temperature", air_temperature_min: "daily minimum temperature",
  precipitation_amount: "daily precipitation" };

/**
 * Supervisor-side gate. Pi's claim of success is not trusted: every check is re-run here against the
 * source bytes, and the publication payload is built from files that just passed those checks.
 */
export async function buildPublication(ws: Workspace, agent: { model: string }) {
  const manifest = await ws.readJson<{ validation: { fingerprint: string }; summary: string }>("manifest.json");
  if (!manifest) throw new VerificationError("Agent did not submit a manifest.");
  const report = await validateOutput(ws);
  if (!report.passed) throw new VerificationError(`Supervisor validation failed: ${report.checks.filter(c => !c.passed).map(c => c.name).join(", ")}`);
  if (report.fingerprint !== manifest.validation.fingerprint) throw new VerificationError("Submitted manifest does not match the verified files.");
  const t = ws.target, spec = sourceSpecs[t.source as AcquirableSource], { col, row, width, height } = t.window, r = spec.grid.resolution;
  const receipts: Receipt[] = await Promise.all(ws.objects().map(async o => (await ws.receipt(o))!));
  const tiles = [], notes: Record<string, Record<string, string | number>> = {};
  let missing = 0, tags: Record<string, string> = {};
  for (const date of ws.dates()) {
    const normalized = (await ws.readJson<Normalized>("normalized", `${date}.json`))!;
    missing += normalized.stats.missing; tags = { ...normalized.tags, ...tags };
    for (const [k, v] of Object.entries(normalized.notes)) (notes[k] ??= {})[String(v)] = ((notes[k]?.[String(v)] as number) ?? 0) + 1;
    tiles.push({ id: `d${date.replaceAll("-", "")}`, variable: t.variable, unit: t.unit, observed_on: date, width, height, crs: "EPSG:4326",
      transform: [r, 0, t.bbox[0], 0, -r, t.bbox[3]], bbox: t.bbox, cells: normalized.cells, source_window: [col, row, width, height] });
  }
  // Content identity covers values and their spatial/temporal meaning, not retrieval times.
  const contentSha256 = sha256(JSON.stringify({ transformVersion: t.transformVersion, tiles: tiles.map(x =>
    [x.id, x.observed_on, x.variable, x.unit, x.crs, x.width, x.height, x.transform, x.bbox, x.source_window, x.cells]) }));
  const compact = (d: string) => d.replaceAll("-", ""), name = shortName[t.variable] ?? t.variable;
  const id = `${t.source}-${name}-${compact(t.period.start)}-${compact(t.period.end)}-${sha256(contentSha256 + t.transformVersion).slice(0, 16)}`;
  const ew = (v: number) => `${Math.abs(v)}°${v < 0 ? "W" : "E"}`, ns = (v: number) => `${Math.abs(v)}°${v < 0 ? "S" : "N"}`;
  const dataset = {
    id, dataset_key: `${t.source}-${name}-daily`,
    title: `${spec.title} ${titles[t.variable] ?? t.variable}, ${t.period.start}${t.period.end === t.period.start ? "" : ` to ${t.period.end}`}, ${ew(t.bbox[0])}–${ew(t.bbox[2])}, ${ns(t.bbox[1])}–${ns(t.bbox[3])}`,
    content_sha256: contentSha256,
    source_manifest: receipts.map(x => ({ url: x.url, sha256: x.sha256, bytes: x.bytes, etag: x.etag, last_modified: x.lastModified,
      retrieved_at: x.fetchedAt, member_path: x.key, dates: x.dates, license: spec.license, ...(Object.keys(tags).length ? { source_tags: tags } : {}) })),
    transform_version: t.transformVersion, data_class: "interpolated_observation", variables: { [t.variable]: t.unit },
    temporal_resolution: "daily", spatial_support: { crs: "EPSG:4326", support: "native grid cell", resolution_degrees: r },
    bbox: t.bbox, period_start: t.period.start, period_end: t.period.end, license: spec.license, attribution: spec.attribution,
    metadata: { source: t.source, product: spec.product, source_url: spec.url, layout: "top-down row-major",
      cell_count: tiles.length * width * height, tile_count: tiles.length, missing_count: missing, missing_policy: "preserve as NULL",
      source_dimensions: [spec.grid.width, spec.grid.height], source_window: [col, row, width, height], source_notes: notes,
      acquisition: { id: ws.job.acquisitionId, attempt: ws.job.attempt, agent: "pi", model: agent.model, summary: manifest.summary,
        validation: { fingerprint: report.fingerprint, checks: report.checks.map(c => c.name), warnings: report.warnings } } },
  };
  return { dataset, tiles, stats: { tiles: tiles.length, cells: tiles.length * width * height, missing } };
}
