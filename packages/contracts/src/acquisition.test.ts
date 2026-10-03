import test from "node:test";
import assert from "node:assert/strict";
import { dataRequestSchema, exampleRequest, type DataRequest } from "./index.js";
import { coverageDigest, planAcquisition, preferredSource, siloGrid, sourceSpecs, windowBbox } from "./acquisition.js";

const now = new Date("2026-10-03T12:00:00Z");
const request: DataRequest = { ...exampleRequest, period: { start: "2003-01-02", end: "2003-01-04" }, format: "json" };
const contains = (outer: number[], inner: number[]) => outer[0]! <= inner[0]! && outer[1]! <= inner[1]! && outer[2]! >= inner[2]! && outer[3]! >= inner[3]!;

test("maps a cache miss to a snapped, deterministic SILO window", () => {
  const plan = planAcquisition(request, now);
  assert.ok(plan.ok);
  // Mildura request [142.30,-34.45,142.40,-34.35] snaps to the enclosing 1° block of native cells.
  assert.deepEqual(plan.target.window, { col: 600, row: 480, width: 20, height: 20 });
  assert.deepEqual(plan.target.bbox, [141.975, -34.975, 142.975, -33.975]);
  assert.equal(plan.days, 3);
  assert.equal(plan.coverageDigest, coverageDigest(plan.target));
  // Representation does not change what must be acquired.
  const csv = planAcquisition({ ...request, format: "csv" }, now);
  assert.ok(csv.ok);
  assert.equal(csv.coverageDigest, plan.coverageDigest);
  const later = planAcquisition({ ...request, period: { start: "2003-01-02", end: "2003-01-05" } }, now);
  assert.ok(later.ok);
  assert.notEqual(later.coverageDigest, plan.coverageDigest);
});
test("rejects requests acquisition cannot satisfy before any work is queued", () => {
  const reason = (input: DataRequest) => { const p = planAcquisition(input, now); return p.ok ? "ok" : p.reason; };
  assert.equal(reason({ ...request, period: { start: "2026-10-02", end: "2026-10-03" } }), "outside_source_coverage");
  assert.equal(reason({ ...request, period: { start: "1888-12-31", end: "1889-01-01" } }), "outside_source_coverage");
  assert.equal(reason({ ...request, source_preference: "silo", region: { ...request.region, bbox: [110, -34, 112.5, -33] } }), "outside_source_coverage");
  assert.equal(reason({ ...request, period: { start: "2003-01-01", end: "2003-02-01" } }), "request_too_large");
  assert.equal(reason({ ...request, region: { ...request.region, bbox: [130, -30, 136, -24] } }), "request_too_large");
  assert.equal(reason({ ...request, region: { ...request.region, bbox: [142.31, -34.41, 142.32, -34.40] } }), "no_cell_centers");
  assert.equal(reason({ ...request, dataset_version: "silo-tmax-20030101-e165b22947cfbbc5" }), "dataset_version_pinned");
});
test("acquired windows always contain the request and stay within tile limits", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const extent = windowBbox({ col: 0, row: 0, width: siloGrid.width, height: siloGrid.height }, siloGrid);
  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const w = Math.round((extent[0] + random() * 41) * 1e6) / 1e6, s = Math.round((extent[1] + random() * 33) * 1e6) / 1e6;
    const bbox: [number, number, number, number] = [w, s, Math.min(extent[2], w + 0.001 + random() * 3), Math.min(extent[3], s + 0.001 + random() * 3)];
    const plan = planAcquisition({ ...request, period: { start: "2003-01-02", end: "2003-01-02" }, region: { bbox, crs: "EPSG:4326" } }, now);
    if (!plan.ok) { assert.ok(["no_cell_centers", "request_too_large"].includes(plan.reason)); continue; }
    accepted++;
    assert.ok(contains(plan.target.bbox, bbox), `window ${plan.target.bbox} must contain ${bbox}`);
    assert.ok(plan.target.window.width <= 256 && plan.target.window.height <= 256);
    assert.ok(plan.target.window.col + plan.target.window.width <= siloGrid.width && plan.target.window.row + plan.target.window.height <= siloGrid.height);
  }
  assert.ok(accepted > 1000);
});
test("auto selection uses the finest source covering the bounds, and pinned sources stay pinned", () => {
  const at = (bbox: [number, number, number, number], extra: Partial<DataRequest> = {}) =>
    ({ ...request, source_preference: "auto" as const, region: { bbox, crs: "EPSG:4326" as const }, ...extra });
  assert.equal(preferredSource(at([142.3, -34.45, 142.4, -34.35])), "silo");
  assert.equal(preferredSource(at([-98.1, 38.4, -98, 38.5])), "nclimgrid");
  assert.equal(preferredSource(at([10, 45, 11, 46])), "cpc");
  assert.equal(preferredSource(at([-125, 48, -123, 50])), "cpc"); // crosses the nClimGrid edge
  const us = planAcquisition(at([-98.1, 38.4, -98, 38.5]), now);
  assert.ok(us.ok);
  // 1/24° grid, snapped to the enclosing 1° block: 24 × 24 native cells.
  assert.deepEqual([us.target.source, us.target.sourceVariable, us.target.window.width, us.target.window.height], ["nclimgrid", "tmax", 24, 24]);
  assert.equal(us.target.transformVersion, sourceSpecs.nclimgrid.transformVersion);
  const rain = planAcquisition(at([-98.1, 38.4, -98, 38.5], { variables: ["precipitation_amount"], units: { precipitation_amount: "mm" } }), now);
  assert.ok(rain.ok);
  assert.equal(rain.target.sourceVariable, "prcp");
  assert.notEqual(rain.coverageDigest, us.coverageDigest);
  // nClimGrid lags about four days; CPC about two.
  const recent = planAcquisition(at([-98.1, 38.4, -98, 38.5], { period: { start: "2026-10-01", end: "2026-10-01" } }), now);
  assert.equal(recent.ok ? "ok" : recent.reason, "outside_source_coverage");
  // A 0.1° box holds no 0.5° CPC cell centre; a 1° box holds four.
  assert.equal((p => p.ok ? "ok" : p.reason)(planAcquisition(at([142.3, -34.45, 142.4, -34.35], { source_preference: "cpc" }), now)), "no_cell_centers");
  const pinned = planAcquisition(at([142, -35, 143, -34], { source_preference: "cpc" }), now);
  assert.ok(pinned.ok);
  assert.equal(pinned.target.source, "cpc");
  // Existing SILO maximum-temperature targets keep their digests (and so their deduplication).
  const silo = planAcquisition(request, now);
  assert.equal(silo.ok && silo.target.transformVersion, "verdant-silo-daily-geotiff-v1");
});
test("units must match the requested variable", () => {
  assert.equal(dataRequestSchema.safeParse({ ...request, units: { air_temperature_min: "degC" } }).success, false);
  assert.equal(dataRequestSchema.safeParse({ ...request, variables: ["precipitation_amount"], units: { precipitation_amount: "mm" } }).success, true);
  assert.equal(dataRequestSchema.safeParse({ ...exampleRequest, source_preference: undefined }).data?.source_preference, "auto");
});
