// NOAA nClimGrid-Daily (CONUS, 1/24°), monthly NetCDF4 files on the AWS Open Data bucket. Each file holds
// tmax/tmin/tavg/prcp for one month; final ("scaled") files replace preliminary ones about five weeks after month end.
import { createHash } from "node:crypto";
import h5wasm, { type Dataset } from "h5wasm/node";
import { dateRange, sourceSpecs, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { boundedGet, float32, SourceError, type Availability, type SourceAdapter, type SourceObject } from "./types";

const host = "noaa-nclimgrid-daily-pds.s3.amazonaws.com", origin = `https://${host}`;
const allowed = { host, pathPrefix: "/access/grids/" };
const grid = sourceSpecs.nclimgrid.grid;
const months = (target: AcquisitionTarget) => [...new Set(dateRange(target.period.start, target.period.end).map(d => d.slice(0, 7)))];
const key = (month: string, kind: "scaled" | "prelim") => `access/grids/${month.slice(0, 4)}/ncdd-${month.replace("-", "")}-grd-${kind}.nc`;
const daysSince1800 = (days: number) => new Date(Date.UTC(1800, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);
// Coordinates are stored as float32: 1e-4° is far below the 1/24° cell size but above float32 rounding.
const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-4;

/** "nClimGrid-Daily v1-0-0 prelim for 2026-09-01 through 2026-09-29" */
async function monthStatus(month: string, signal?: AbortSignal) {
  try {
    const url = new URL(`${origin}/access/grids/${month.slice(0, 4)}/ncdd-${month.replace("-", "")}-version.txt`);
    const text = (await boundedGet(url, allowed, 64 * 1024, signal)).body.toString("utf8");
    const match = /(prelim|complete) for (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})/.exec(text);
    if (!match) throw new SourceError("Unrecognized nClimGrid version file.", true);
    return { status: match[1] as "prelim" | "complete", first: match[2]!, last: match[3]! };
  } catch (error) {
    if (error instanceof SourceError && /not found/.test(error.message)) return null;
    throw error;
  }
}

export const nclimgrid: SourceAdapter = {
  objects(target) {
    const dates = dateRange(target.period.start, target.period.end);
    return months(target).map(month => ({ id: month.replace("-", ""), url: `${origin}/${key(month, "scaled")}`, key: key(month, "scaled"),
      alternates: [{ url: `${origin}/${key(month, "prelim")}`, key: key(month, "prelim") }], dates: dates.filter(d => d.startsWith(month)) }));
  },
  async inspect(target, signal) {
    const status = new Map<string, Awaited<ReturnType<typeof monthStatus>>>();
    for (const month of months(target)) status.set(month, await monthStatus(month, signal));
    return dateRange(target.period.start, target.period.end).map((date): Availability => {
      const s = status.get(date.slice(0, 7));
      return { date, available: Boolean(s && date >= s.first && date <= s.last) };
    });
  },
  async download(object, signal) {
    // Final file first; until it exists the preliminary file is the source of record.
    for (const candidate of [{ url: object.url, key: object.key }, ...(object.alternates ?? [])]) {
      try {
        const got = await boundedGet(new URL(candidate.url), allowed, 128 * 1024 * 1024, signal);
        // Single-part S3 ETags are the object's MD5: an end-to-end integrity check on the transfer.
        if (got.etag && !got.etag.includes("-") && createHash("md5").update(got.body).digest("hex") !== got.etag)
          throw new SourceError("Downloaded nClimGrid file does not match its ETag.");
        return { ...got, ...candidate };
      } catch (error) {
        if (!(error instanceof SourceError && /not found/.test(error.message))) throw error;
      }
    }
    throw new SourceError(`No nClimGrid file exists for ${object.id}.`, true);
  },
  async decode(target, date, files) {
    const object = nclimgrid.objects(target).find(o => o.dates.includes(date))!;
    await h5wasm.ready;
    const file = new h5wasm.File(await files.path(object), "r");
    try {
      const lat = file.get("lat") as Dataset, lon = file.get("lon") as Dataset, time = file.get("time") as Dataset;
      const variable = file.get(target.sourceVariable) as Dataset | null;
      if (!variable || !lat || !lon || !time) throw new SourceError("Source format changed: missing variables.", true);
      const lats = lat.value as Float64Array | Float32Array, lons = lon.value as Float64Array | Float32Array;
      const step = grid.resolution, south = grid.north - grid.height * step;
      // File rows run south to north; target rows run north to south.
      const problems = [
        lats.length !== grid.height || lons.length !== grid.width ? "dimensions" : "",
        !near(lats[0], south + step / 2) || !near(lats[lats.length - 1], grid.north - step / 2) ? "latitude" : "",
        !near(lons[0], grid.west + step / 2) || !near(lons[lons.length - 1], grid.west + (grid.width - 0.5) * step) ? "longitude" : "",
        JSON.stringify(variable.shape?.slice(1)) !== JSON.stringify([grid.height, grid.width]) ? "variable shape" : "",
      ].filter(Boolean);
      if (problems.length) throw new SourceError(`Source format changed: ${problems.join(", ")}.`, true);
      const t = Array.from(time.value as ArrayLike<number | bigint>, v => daysSince1800(Number(v))).indexOf(date);
      if (t < 0) throw new SourceError(`${date} is not in the nClimGrid file yet.`);
      const { col, row, width, height } = target.window, y0 = grid.height - row - height;
      const block = variable.slice([[t, t + 1], [y0, y0 + height], [col, col + width]]) as Float64Array | Float32Array;
      if (block.length !== width * height) throw new SourceError("Decoded window has the wrong size.", true);
      const cells: (number | null)[] = [];
      let pending = 0;
      for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
        const v = block[(height - 1 - r) * width + c]!;
        if (Number.isNaN(v)) cells.push(null);              // outside CONUS land
        else if (v < -900) { pending++; cells.push(null); } // -999.99: day not yet computed in a preliminary file
        else cells.push(float32(Math.round(v * 100) / 100)); // stored with least_significant_digit=2
      }
      if (pending) throw new SourceError(`${date} is not complete in the preliminary nClimGrid file yet.`);
      return { cells, tags: { source: "NOAA NCEI nClimGrid-Daily v1-0-0", file: object.id },
        notes: { precision: "rounded to 0.01 (least_significant_digit=2)", missing: "NaN outside CONUS land" } };
    } finally { file.close(); }
  },
};
