import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquisitionTargetSchema, planAcquisition, sourceSpecs, type AcquisitionTarget } from "@verdant/contracts/acquisition";
import { exampleRequest, type DataRequest } from "@verdant/contracts";
import { fetchSource, normalizeSource, submitManifest, validateOutput, Workspace } from "./operations";
import { cpc, parseAscii } from "./sources/cpc";
import { nclimgrid } from "./sources/nclimgrid";
import { decodeWindow, silo, sourceUrl } from "./sources/silo";
import { float32 } from "./sources/types";
import { agentEnvironment } from "./supervisor";

// Published production tile silo-tmax-20030101-e165b22947cfbbc5/mildura (source window 560,440,81,81).
const mildura = acquisitionTargetSchema.parse({ source: "silo", variable: "air_temperature_max", sourceVariable: "max_temp", unit: "degC",
  period: { start: "2003-01-01", end: "2003-01-01" }, window: { col: 560, row: 440, width: 81, height: 81 },
  bbox: [139.975, -36.025, 144.025, -31.975], transformVersion: sourceSpecs.silo.transformVersion });
const publishedCellsSha256 = "0000e879786ee1ff7fc56f39314e6686a401bd86365e3f17eab402c7831d5473";
const request = (bbox: [number, number, number, number], start: string, end = start, variable: DataRequest["variables"][0] = "air_temperature_max"): DataRequest =>
  ({ ...exampleRequest, variables: [variable], units: { [variable]: variable === "precipitation_amount" ? "mm" : "degC" }, format: "json",
    source_preference: "auto", region: { bbox, crs: "EPSG:4326" }, period: { start, end } });
const target = (r: DataRequest): AcquisitionTarget => { const p = planAcquisition(r, new Date("2026-10-03T12:00:00Z")); assert.ok(p.ok, JSON.stringify(p)); return p.target; };
const network = !process.env.VERDANT_NETWORK_TESTS;

test("Pi receives the model credential but no database, payment or worker secrets", () => {
  const env = agentEnvironment("/jobs/x", { ANTHROPIC_API_KEY: "model-key", SUPABASE_SECRET_KEY: "db", SUPABASE_URL: "https://db",
    STRIPE_SECRET_KEY: "pay", MPP_SECRET_KEY: "mpp", VERDANT_WORKER_TOKEN: "w", API_ADMIN_TOKEN: "a", PATH: "/bin", HOME: "/Users/me" });
  assert.equal(env.ANTHROPIC_API_KEY, "model-key");
  assert.equal(env.HOME, "/jobs/x");
  for (const key of Object.keys(env)) assert.ok(!/SUPABASE|STRIPE|MPP|TOKEN/.test(key), `${key} must not reach Pi`);
});
test("float32 values serialize as the shortest round-trip decimal, like Postgres real", () => {
  assert.equal(float32(Math.fround(24.2)), 24.2);
  assert.equal(float32(Math.fround(-0.1)), -0.1);
  assert.equal(Math.fround(float32(Math.fround(1 / 3))), Math.fround(1 / 3));
});
test("tools refuse dates outside the target and validation fails closed without data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdant-acq-"));
  try {
    const ws = await Workspace.create(dir, { acquisitionId: "test", attempt: 1, target: mildura });
    await assert.rejects(fetchSource(ws, ["2003-01-02"]), /outside the target period/);
    assert.equal((await normalizeSource(ws)).failed.length, 1);
    const report = await validateOutput(ws);
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(c => c.name === "source_objects_complete")?.passed, false);
    await assert.rejects(submitManifest(ws, "done"), /has not passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("source objects are canonical, allowlisted and split where a source needs it", () => {
  assert.equal(sourceUrl("max_temp", "2003-01-01"), "https://s3-ap-southeast-2.amazonaws.com/silo-open-data/Official/daily/max_temp/2003/20030101.max_temp.tif");
  assert.throws(() => sourceUrl("../max_temp", "2003-01-01"));
  const kansas = target(request([-98.1, 38.4, -98, 38.5], "2004-01-30", "2004-02-02"));
  assert.equal(kansas.source, "nclimgrid");
  assert.deepEqual(nclimgrid.objects(kansas).map(o => [o.id, o.dates.length, o.alternates?.[0]?.key]),
    [["200401", 2, "access/grids/2004/ncdd-200401-grd-prelim.nc"], ["200402", 2, "access/grids/2004/ncdd-200402-grd-prelim.nc"]]);
  // A window crossing 0° becomes two OPeNDAP requests per year; years split too.
  const greenwich = target({ ...request([-0.6, 51.2, 0.6, 51.8], "2003-12-31", "2004-01-01"), source_preference: "cpc" });
  assert.deepEqual(cpc.objects(greenwich).map(o => o.id), ["2003-c718-719", "2003-c0-1", "2004-c718-719", "2004-c0-1"]);
  assert.match(cpc.objects(greenwich)[0]!.url, /^https:\/\/psl\.noaa\.gov\/thredds\/dodsC\/Datasets\/cpc_global_temp\/tmax\.2003\.nc\.ascii\?tmax\[364:364\]\[76:77\]\[718:719\]$/);
  assert.equal(target(request([10, 45, 11, 46], "2010-06-01", "2010-06-01", "precipitation_amount")).source, "cpc");
});
test("CPC ASCII responses are parsed with their coordinate maps", () => {
  const text = `Dataset {\n} x;\n---------------------------------------------\ntmax.tmax[2][2][3]\n[0][0], -9.96921E36, 21.5, 22\n[0][1], 1, 2, 3\n[1][0], 4, 5, 6\n[1][1], 7, 8, 9\n\ntmax.time[2]\n911640.0, 911664.0\n\ntmax.lat[2]\n34.75, 34.25\n\ntmax.lon[3]\n141.75, 142.25, 142.75\n`;
  const parsed = parseAscii(text, "tmax");
  assert.deepEqual([parsed.nt, parsed.ny, parsed.nx], [2, 2, 3]);
  assert.deepEqual(parsed.values[0]![0], [-9.96921e36, 21.5, 22]);
  assert.deepEqual(parsed.lat, [34.75, 34.25]);
  assert.deepEqual(parsed.time, [911640, 911664]);
});

// Network: VERDANT_NETWORK_TESTS=1 pnpm --filter @verdant/worker test
async function acquire(t: AcquisitionTarget) {
  const dir = await mkdtemp(path.join(tmpdir(), "verdant-acq-"));
  const ws = await Workspace.create(dir, { acquisitionId: "test", attempt: 1, target: t });
  assert.ok((await ws.adapter.inspect(t)).every(a => a.available));
  const fetched = await fetchSource(ws, ws.dates());
  assert.deepEqual(fetched.failed, [], JSON.stringify(fetched.results));
  assert.deepEqual((await normalizeSource(ws)).failed, []);
  const report = await validateOutput(ws);
  assert.ok(report.passed, JSON.stringify(report));
  assert.equal((await submitManifest(ws, "test")).submitted, true);
  return { ws, dir };
}
test("SILO reproduces the published Mildura tile from the live source", { skip: network }, async () => {
  const { ws, dir } = await acquire(mildura);
  try {
    const day = (await ws.readJson<{ cells: (number | null)[] }>("normalized", "2003-01-01.json"))!;
    assert.equal(createHash("sha256").update(JSON.stringify(day.cells)).digest("hex"), publishedCellsSha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("SILO legacy ocean sentinel (-3276.8) becomes null only as the full ocean mask", { skip: network }, async () => {
  const melbourne = { ...mildura, period: { start: "1900-01-01", end: "1900-01-01" }, window: { col: 640, row: 540, width: 40, height: 20 },
    bbox: [143.975, -37.975, 145.975, -36.975] as [number, number, number, number] };
  const [object] = silo.objects(melbourne);
  const { cells, notes } = await decodeWindow((await silo.download(object!)).body, melbourne);
  assert.equal(notes.nodata_encoding, "legacy_scaled_-3276.8");
  assert.equal(cells.filter(v => v === null).length, 5); // Port Phillip Bay
  assert.ok(cells.every(v => v === null || v > -20));
});
test("NOAA CPC subsets validate across a year boundary and the Greenwich split", { skip: network }, async () => {
  const t = target({ ...request([-0.6, 51.2, 0.6, 51.8], "2003-12-31", "2004-01-01"), source_preference: "cpc" });
  const { ws, dir } = await acquire(t);
  try {
    const day = (await ws.readJson<{ cells: (number | null)[] }>("normalized", "2004-01-01.json"))!;
    assert.equal(day.cells.length, t.window.width * t.window.height);
    assert.ok(day.cells.some(v => v !== null && v > -10 && v < 20), "London in January");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("NOAA nClimGrid-Daily decodes a flipped CONUS window", { skip: network }, async () => {
  const t = target(request([-98.1, 38.4, -98, 38.5], "2004-01-01", "2004-01-02"));
  const { ws, dir } = await acquire(t);
  try {
    const day = (await ws.readJson<{ cells: (number | null)[] }>("normalized", "2004-01-01.json"))!;
    assert.equal(day.cells.length, 24 * 24);
    assert.ok(day.cells.every(v => v !== null && v > -30 && v < 30), "central Kansas, January");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
