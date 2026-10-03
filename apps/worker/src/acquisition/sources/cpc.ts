// NOAA CPC Global Unified daily grids (0.5°), subset server-side through NOAA PSL's OPeNDAP service.
// Native longitudes are 0.25…359.75°E; targets use a −180…180 frame, so a window crossing 0° becomes two requests.
import { dateRange, sourceSpecs, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { boundedGet, float32, SourceError, yearsOf, type Availability, type SourceAdapter, type SourceObject } from "./types";

const host = "psl.noaa.gov", base = "https://psl.noaa.gov/thredds/dodsC/Datasets";
const allowed = { host, pathPrefix: "/thredds/dodsC/Datasets/cpc_global_" };
const grid = sourceSpecs.cpc.grid;
const missingValue = -9.96921e36;
const datasetFor = (variable: string) => {
  if (variable === "tmax" || variable === "tmin") return "cpc_global_temp";
  if (variable === "precip") return "cpc_global_precip";
  throw new SourceError(`Unsupported CPC variable ${variable}.`, true);
};
const fileUrl = (variable: string, year: string) => `${base}/${datasetFor(variable)}/${variable}.${year}.nc`;
const dayOfYear = (date: string) => (Date.parse(date) - Date.parse(`${date.slice(0, 4)}-01-01`)) / 86_400_000;
const hoursToDate = (hours: number) => new Date(Date.UTC(1900, 0, 1) + hours * 3_600_000).toISOString().slice(0, 10);
/** Native column ranges, west to east, for the target window. */
function segments(target: AcquisitionTarget) {
  const out: { first: number; last: number; offset: number }[] = [];
  for (let i = 0; i < target.window.width; i++) {
    const native = (target.window.col + i + grid.width / 2) % grid.width, last = out.at(-1);
    if (last && native === last.last + 1) last.last = native; else out.push({ first: native, last: native, offset: i });
  }
  return out;
}

/** Parse an OPeNDAP ASCII grid response: values[t][y][x] plus its time/lat/lon maps. */
export function parseAscii(text: string, variable: string) {
  const [, data] = text.split(/^-{20,}$/m);
  if (!data) throw new SourceError("Unexpected OPeNDAP response.", true);
  const header = new RegExp(`^${variable}\\.${variable}\\[(\\d+)\\]\\[(\\d+)\\]\\[(\\d+)\\]$`, "m").exec(data);
  if (!header) throw new SourceError("OPeNDAP response lacks the requested grid.", true);
  const [nt, ny, nx] = header.slice(1).map(Number) as [number, number, number];
  const values = Array.from({ length: nt }, () => Array.from({ length: ny }, () => [] as number[]));
  for (const [, t, y, list] of data.matchAll(/^\[(\d+)\]\[(\d+)\], (.*)$/gm)) values[Number(t)]![Number(y)] = list!.split(", ").map(Number);
  const map = (name: string) => (new RegExp(`^${variable}\\.${name}\\[\\d+\\]\\n(.*)$`, "m").exec(data)?.[1] ?? "").split(", ").filter(Boolean).map(Number);
  return { nt, ny, nx, values, time: map("time"), lat: map("lat"), lon: map("lon") };
}

export const cpc: SourceAdapter = {
  objects(target) {
    const dates = dateRange(target.period.start, target.period.end), { row, height } = target.window;
    return yearsOf(dates).flatMap(year => {
      const days = dates.filter(d => d.startsWith(year)), t0 = dayOfYear(days[0]!), t1 = dayOfYear(days.at(-1)!);
      return segments(target).map(s => ({ id: `${year}-c${s.first}-${s.last}`, dates: days, key: `${datasetFor(target.sourceVariable)}/${target.sourceVariable}.${year}.nc`,
        url: `${fileUrl(target.sourceVariable, year)}.ascii?${target.sourceVariable}[${t0}:${t1}][${row}:${row + height - 1}][${s.first}:${s.last}]` }));
    });
  },
  async inspect(target, signal) {
    const dates = dateRange(target.period.start, target.period.end), available = new Set<string>();
    for (const year of yearsOf(dates)) {
      const text = (await boundedGet(new URL(`${fileUrl(target.sourceVariable, year)}.ascii?time`), allowed, 1024 * 1024, signal)).body.toString("utf8");
      const [, values] = /^time\[\d+\]\n(.*)$/m.exec(text.split(/^-{20,}$/m)[1] ?? "") ?? [];
      for (const hours of (values ?? "").split(", ").filter(Boolean)) available.add(hoursToDate(Number(hours)));
    }
    return dates.map((date): Availability => ({ date, available: available.has(date) }));
  },
  download: (object: SourceObject, signal) => boundedGet(new URL(object.url), allowed, 32 * 1024 * 1024, signal),
  async decode(target, date, files) {
    const { width, height, row } = target.window, cells: (number | null)[] = new Array(width * height).fill(null);
    for (const s of segments(target)) {
      const object = cpc.objects(target).find(o => o.dates.includes(date) && o.id.endsWith(`-c${s.first}-${s.last}`))!;
      const parsed = parseAscii((await files.read(object)).toString("utf8"), target.sourceVariable);
      const t = object.dates.indexOf(date), columns = s.last - s.first + 1;
      // The server's own coordinate maps must match the requested cells exactly.
      const problems = [
        parsed.nt !== object.dates.length || parsed.ny !== height || parsed.nx !== columns ? "dimensions" : "",
        parsed.time.length !== parsed.nt || parsed.time.some((h, i) => hoursToDate(h) !== object.dates[i]) ? "time axis" : "",
        parsed.lat.some((v, i) => Math.abs(v - (grid.north - (row + i + 0.5) * grid.resolution)) > 1e-6) ? "latitude" : "",
        parsed.lon.some((v, i) => Math.abs(v - (s.first + i + 0.5) * grid.resolution) > 1e-6) ? "longitude" : "",
      ].filter(Boolean);
      if (problems.length) throw new SourceError(`Source format changed: ${problems.join(", ")}.`, true);
      for (let y = 0; y < height; y++) {
        const line = parsed.values[t]![y]!;
        if (line.length !== columns) throw new SourceError("Source format changed: row length.", true);
        line.forEach((v, x) => { cells[y * width + s.offset + x] = v <= missingValue / 10 ? null : float32(v); });
      }
    }
    return { cells, tags: { source: "NOAA CPC Global Unified (PSL OPeNDAP)" }, notes: { missing_value: missingValue } };
  },
};
