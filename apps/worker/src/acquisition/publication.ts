import { siloGrid, siloLicense } from "@verdant/contracts/acquisition";
import { sha256, validateOutput, type Receipt, type Workspace } from "./operations";

type Normalized = { date: string; sourceSha256: string; cells: (number | null)[]; stats: { missing: number; nodataEncoding: string }; tags: Record<string, string> };
export class VerificationError extends Error {}

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
  const t = ws.target, { col, row, width, height } = t.window, r = siloGrid.resolution;
  const receipts: Receipt[] = [], tiles = [];
  let missing = 0, legacyDays = 0, tags: Record<string, string> = {};
  for (const date of ws.dates()) {
    const receipt = (await ws.receipt(date))!, normalized = (await ws.readJson<Normalized>("normalized", `${date}.json`))!;
    receipts.push(receipt); missing += normalized.stats.missing; tags = { ...normalized.tags, ...tags };
    if (normalized.stats.nodataEncoding === "legacy_scaled") legacyDays++;
    tiles.push({ id: `d${date.replaceAll("-", "")}`, variable: t.variable, unit: t.unit, observed_on: date, width, height, crs: "EPSG:4326",
      transform: [r, 0, t.bbox[0], 0, -r, t.bbox[3]], bbox: t.bbox, cells: normalized.cells, source_window: [col, row, width, height] });
  }
  // Content identity covers values and their spatial/temporal meaning, not retrieval times.
  const contentSha256 = sha256(JSON.stringify({ transformVersion: t.transformVersion, tiles: tiles.map(x =>
    [x.id, x.observed_on, x.variable, x.unit, x.crs, x.width, x.height, x.transform, x.bbox, x.source_window, x.cells]) }));
  const compact = (d: string) => d.replaceAll("-", "");
  const id = `silo-tmax-${compact(t.period.start)}-${compact(t.period.end)}-${sha256(contentSha256 + t.transformVersion).slice(0, 16)}`;
  const place = `${t.bbox[0]}–${t.bbox[2]}°E, ${-t.bbox[3]}–${-t.bbox[1]}°S`;
  const dataset = {
    id, dataset_key: "silo-tmax-daily",
    title: `SILO daily maximum temperature, ${t.period.start}${t.period.end === t.period.start ? "" : ` to ${t.period.end}`}, ${place}`,
    content_sha256: contentSha256,
    source_manifest: receipts.map(x => ({ url: x.url, sha256: x.sha256, bytes: x.bytes, etag: x.etag, last_modified: x.lastModified,
      retrieved_at: x.fetchedAt, member_path: x.key, license: siloLicense.license, ...(Object.keys(tags).length ? { source_tags: tags } : {}) })),
    transform_version: t.transformVersion, data_class: "interpolated_observation", variables: { [t.variable]: t.unit },
    temporal_resolution: "daily", spatial_support: { crs: "EPSG:4326", support: "native grid cell", resolution_degrees: r },
    bbox: t.bbox, period_start: t.period.start, period_end: t.period.end, ...siloLicense,
    metadata: { layout: "top-down row-major", cell_count: tiles.length * width * height, tile_count: tiles.length, missing_count: missing,
      missing_policy: "preserve as NULL", source_dimensions: [siloGrid.width, siloGrid.height], source_window: [col, row, width, height],
      source_nodata: { declared: siloGrid.nodata, ocean_mask_cells: siloGrid.oceanCells,
        ...(legacyDays ? { legacy_scaled: siloGrid.legacyNodata, legacy_days: legacyDays,
          note: "These source files mark the ocean mask as -3276.8 while declaring -32767; both are stored as NULL." } : {}) },
      acquisition: { id: ws.job.acquisitionId, attempt: ws.job.attempt, agent: "pi", model: agent.model, summary: manifest.summary,
        validation: { fingerprint: report.fingerprint, checks: report.checks.map(c => c.name), warnings: report.warnings } } },
  };
  return { dataset, tiles, stats: { tiles: tiles.length, cells: tiles.length * width * height, missing } };
}
