import { fromArrayBuffer } from "geotiff";
import { siloGrid, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { boundedGet, float32, SourceError, yearsOf, type Availability, type SourceAdapter, type SourceObject } from "./types";
import { dateRange } from "@verdant/contracts/acquisition";

const bucket = new URL(siloGrid.bucket);
const allowed = { host: bucket.host, pathPrefix: bucket.pathname };

export function sourceKey(variable: string, date: string) {
  if (!/^[a-z_]+$/.test(variable) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SourceError("Invalid source key.", true);
  return `Official/daily/${variable}/${date.slice(0, 4)}/${date.replaceAll("-", "")}.${variable}.tif`;
}
export const sourceUrl = (variable: string, date: string) => `${siloGrid.bucket}/${sourceKey(variable, date)}`;

/** List one year of daily objects through the bucket's public S3 ListObjectsV2 API. */
async function listYear(variable: string, year: string, signal?: AbortSignal) {
  const objects = new Map<string, { key: string; bytes: number; lastModified: string }>();
  let token: string | undefined;
  do {
    const url = new URL(bucket);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", `Official/daily/${variable}/${year}/`);
    if (token) url.searchParams.set("continuation-token", token);
    const xml = (await boundedGet(url, allowed, 2 * 1024 * 1024, signal)).body.toString("utf8");
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(item!)?.[1] ?? "";
      const key = field("Key"), match = /\/(\d{4})(\d{2})(\d{2})\.[a-z_]+\.tif$/.exec(key);
      if (match) objects.set(`${match[1]}-${match[2]}-${match[3]}`, { key, bytes: Number(field("Size")), lastModified: field("LastModified") });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : undefined;
  } while (token);
  return objects;
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
  const cells: (number | null)[] = [];
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const v = grid[(row + r) * siloGrid.width + col + c]!;
    cells.push(v === siloGrid.nodata || v === legacy ? null : float32(v));
  }
  const metadata = (await image.getGDALMetadata() ?? {}) as Record<string, unknown>;
  const tags = Object.fromEntries(["institution", "copyright", "reference", "raster_source"].filter(k => typeof metadata[k] === "string")
    .map(k => [k, String(metadata[k]).slice(0, 300)]));
  return { cells, tags, notes: { nodata_encoding: legacyCells ? "legacy_scaled_-3276.8" : "declared_-32767", ocean_mask_cells: siloGrid.oceanCells } };
}

export const silo: SourceAdapter = {
  objects: target => dateRange(target.period.start, target.period.end).map(date =>
    ({ id: date, url: sourceUrl(target.sourceVariable, date), key: sourceKey(target.sourceVariable, date), dates: [date] })),
  async inspect(target, signal) {
    const dates = dateRange(target.period.start, target.period.end);
    const listings = new Map<string, Awaited<ReturnType<typeof listYear>>>();
    for (const year of yearsOf(dates)) listings.set(year, await listYear(target.sourceVariable, year, signal));
    return dates.map((date): Availability => {
      const object = listings.get(date.slice(0, 4))!.get(date);
      return object && object.key === sourceKey(target.sourceVariable, date)
        ? { date, available: true, bytes: object.bytes, lastModified: object.lastModified } : { date, available: false };
    });
  },
  download: (object: SourceObject, signal) => boundedGet(new URL(object.url), allowed, 8 * 1024 * 1024, signal),
  async decode(target, date, files) {
    const [object] = silo.objects({ ...target, period: { start: date, end: date } });
    return decodeWindow(await files.read(object!), target);
  },
};
