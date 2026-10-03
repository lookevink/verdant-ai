import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fromArrayBuffer } from "geotiff";
import { siloGrid, siloVariables, type AcquisitionTarget } from "@verdant/contracts/acquisition";

/** Thrown for source problems. Permanent errors cannot be fixed by retrying the job. */
export class SourceError extends Error {
  constructor(message: string, readonly permanent = false) { super(message); }
}
const bucket = new URL(siloGrid.bucket);
const maxSourceBytes = 8 * 1024 * 1024;
const maxListBytes = 2 * 1024 * 1024;

export function sourceKey(variable: string, date: string) {
  if (!/^[a-z_]+$/.test(variable) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SourceError("Invalid source key.", true);
  return `Official/daily/${variable}/${date.slice(0, 4)}/${date.replaceAll("-", "")}.${variable}.tif`;
}
export const sourceUrl = (variable: string, date: string) => `${siloGrid.bucket}/${sourceKey(variable, date)}`;

/** Only the public SILO bucket over HTTPS. No redirects, bounded size, bounded retries. */
async function get(url: URL, maxBytes: number, signal?: AbortSignal) {
  if (url.protocol !== "https:" || url.host !== bucket.host || !url.pathname.startsWith(bucket.pathname))
    throw new SourceError("Source URL is outside the allowed SILO bucket.", true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]) });
      if (response.status === 404 || response.status === 403) throw new SourceError(`Source object not found (HTTP ${response.status}).`, true);
      if (!response.ok) throw new SourceError(`Source returned HTTP ${response.status}.`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new SourceError("Source object exceeds the size limit.", true);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new SourceError("Source object exceeds the size limit.", true);
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), etag: response.headers.get("etag")?.replaceAll('"', "") ?? null,
        lastModified: response.headers.get("last-modified") };
    } catch (error) {
      if ((error instanceof SourceError && error.permanent) || signal?.aborted) throw error;
      lastError = error;
      if (attempt < 3) await delay(1000 * attempt * attempt, undefined, { signal });
    }
  }
  throw lastError instanceof SourceError ? lastError : new SourceError(`Source request failed: ${(lastError as Error)?.message ?? "unknown"}`);
}

export type SourceObject = { key: string; date: string; bytes: number; etag: string; lastModified: string };
/** List one year of daily objects through the bucket's public S3 ListObjectsV2 API. */
export async function listYear(variable: string, year: string, signal?: AbortSignal) {
  const objects = new Map<string, SourceObject>();
  let token: string | undefined;
  do {
    const url = new URL(bucket);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", `Official/daily/${variable}/${year}/`);
    if (token) url.searchParams.set("continuation-token", token);
    const xml = (await get(url, maxListBytes, signal)).body.toString("utf8");
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(item!)?.[1] ?? "";
      const key = field("Key"), match = /\/(\d{4})(\d{2})(\d{2})\.[a-z_]+\.tif$/.exec(key);
      if (!match) continue;
      const date = `${match[1]}-${match[2]}-${match[3]}`;
      objects.set(date, { key, date, bytes: Number(field("Size")), etag: field("ETag").replaceAll("&quot;", "").replaceAll('"', ""), lastModified: field("LastModified") });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : undefined;
  } while (token);
  return objects;
}

export async function download(variable: string, date: string, signal?: AbortSignal) {
  const url = sourceUrl(variable, date);
  const { body, etag, lastModified } = await get(new URL(url), maxSourceBytes, signal);
  return { url, key: sourceKey(variable, date), body, bytes: body.byteLength, etag, lastModified,
    sha256: createHash("sha256").update(body).digest("hex") };
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

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
/** Decode a SILO daily GeoTIFF and crop the target window. Rejects any georeference drift as permanent. */
export async function decodeWindow(file: Buffer, target: AcquisitionTarget) {
  const tiff = await fromArrayBuffer(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
  if (await tiff.getImageCount() !== 1) throw new SourceError("Expected one image in the source GeoTIFF.", true);
  const image = await tiff.getImage();
  const [x, y] = image.getOrigin(), [rx, ry] = image.getResolution();
  const geoKeys = image.getGeoKeys() as Record<string, unknown> | null;
  const problems = [
    image.getWidth() !== siloGrid.width || image.getHeight() !== siloGrid.height ? "dimensions" : "",
    image.getSamplesPerPixel() !== 1 || image.getBitsPerSample(0) !== 32 || image.getSampleFormat(0) !== 3 ? "float32 band" : "",
    !near(x, siloGrid.west) || !near(y, siloGrid.north) || !near(rx, siloGrid.resolution) || !near(ry, -siloGrid.resolution) ? "grid origin/resolution" : "",
    geoKeys?.GeographicTypeGeoKey !== 4326 ? "EPSG:4326" : "",
    image.getGDALNoData() !== siloGrid.nodata ? "nodata value" : "",
  ].filter(Boolean);
  if (problems.length) throw new SourceError(`Source format changed: ${problems.join(", ")}.`, true);
  // Missing cells must be exactly the fixed ocean mask, in either encoding; anything else is a format change.
  const [grid] = await image.readRasters() as unknown as [Float32Array];
  const legacy = Math.fround(siloGrid.legacyNodata);
  let declaredCells = 0, legacyCells = 0;
  for (const v of grid) { if (v === siloGrid.nodata) declaredCells++; else if (v === legacy) legacyCells++; }
  if (declaredCells + legacyCells !== siloGrid.oceanCells || (declaredCells && legacyCells))
    throw new SourceError(`Source format changed: ${declaredCells} declared and ${legacyCells} legacy nodata cells, expected one encoding of the ${siloGrid.oceanCells}-cell ocean mask.`, true);
  const { col, row, width, height } = target.window;
  const band = new Float32Array(width * height);
  for (let r = 0; r < height; r++) band.set(grid.subarray((row + r) * siloGrid.width + col, (row + r) * siloGrid.width + col + width), r * width);
  const cells = Array.from(band, v => v === siloGrid.nodata || v === legacy ? null : float32(v));
  const [low, high] = siloVariables[target.variable].plausible;
  let min = Infinity, max = -Infinity, missing = 0, implausible = 0, nonFinite = 0;
  for (const v of cells) {
    if (v === null) { missing++; continue; }
    if (!Number.isFinite(v)) { nonFinite++; continue; }
    if (v < low || v > high) implausible++;
    min = Math.min(min, v); max = Math.max(max, v);
  }
  const metadata = (await image.getGDALMetadata() ?? {}) as Record<string, unknown>;
  const tags = Object.fromEntries(["institution", "copyright", "reference", "raster_source"].filter(k => typeof metadata[k] === "string")
    .map(k => [k, String(metadata[k]).slice(0, 300)]));
  return { cells, stats: { cells: cells.length, missing, min: missing === cells.length ? null : min, max: missing === cells.length ? null : max, implausible, nonFinite,
    nodataEncoding: legacyCells ? "legacy_scaled" as const : "declared" as const }, tags };
}
