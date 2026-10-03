import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exampleRequest, type Dataset, type RasterTile, type DataRequest } from "@verdant/contracts";
import { queryData, resolveData, csvData, QueryError, type DataStore } from "./data-query";

const dataset: Dataset = {
  id: "silo-test", dataset_key: "silo-tmax", title: "Test grid", content_sha256: "a".repeat(64),
  source_manifest: [{ url: "https://www.longpaddock.qld.gov.au/silo/", sha256: "b".repeat(64) }],
  transform_version: "test-v1", data_class: "interpolated_observation", variables: { air_temperature_max: "degC" },
  temporal_resolution: "daily", spatial_support: { crs: "EPSG:4326" }, bbox: [140, -36, 143, -34],
  period_start: "2003-01-01", period_end: "2003-01-02", license: "CC-BY-4.0", attribution: "Test attribution",
  access_level: "demo", metadata: {}, status: "published", published_at: "2026-10-03T00:00:00Z",
};
const tile: RasterTile = { id: "test", dataset_version_id: dataset.id, variable: "air_temperature_max", unit: "degC",
  observed_on: "2003-01-01", width: 3, height: 2, crs: "EPSG:4326", transform: [1, 0, 140, 0, -1, -34],
  bbox: [140, -36, 143, -34], cells: [null, 0, 2, 3, 4, 5], source_window: [0, 0, 3, 2] };
const request: DataRequest = { ...exampleRequest, region: { bbox: [140, -36, 143, -34], crs: "EPSG:4326" }, format: "json" };
const store = (changes: Partial<Dataset> = {}, tiles: RasterTile[] = [tile]): DataStore => ({
  async catalog() { return [{ ...dataset, ...changes }]; },
  async tiles() { return tiles; },
  async tile(_dataset, id) { const t = tiles.find(t => t.id === id); if (!t) throw new Error("Missing fixture"); return t; },
});

test("direct query preserves orientation, null vs zero, provenance and deterministic checksums", async () => {
  const result = await queryData(request, store());
  assert.deepEqual(result.data.map(r => [r.longitude, r.latitude, r.value]), [
    [140.5, -34.5, null], [141.5, -34.5, 0], [142.5, -34.5, 2], [140.5, -35.5, 3], [141.5, -35.5, 4], [142.5, -35.5, 5],
  ]);
  assert.equal(result.manifest.rowCount, 6);
  assert.equal(result.manifest.dataSha256, createHash("sha256").update(JSON.stringify(result.data)).digest("hex"));
  assert.deepEqual(result, await queryData(request, store()));
  assert.match(csvData(result.data), /"air_temperature_max",,"degC"/);
  assert.match(csvData(result.data), /"air_temperature_max","0","degC"/);
});
test("crop includes west/south centers and excludes east/north centers", async () => {
  const result = await queryData({ ...request, region: { ...request.region, bbox: [140.5, -35.5, 142.5, -34.5] } }, store());
  assert.deepEqual(result.data.map(r => r.value), [3, 4]);
});
test("partial coverage, missing dates, incompatible units, unknown pins and paid data never return demo data", async () => {
  for (const [input, source] of [
    [{ ...request, period: { start: "2003-01-01", end: "2003-01-02" } }, store()],
    [{ ...request, region: { ...request.region, bbox: [139, -36, 143, -34] } }, store()],
    [{ ...request, dataset_version: "other" }, store()],
    [request, store({ access_level: "paid" })],
    [request, store({ access_level: "restricted" })],
    [request, store({ status: "staging" })],
    [request, store({ variables: { air_temperature_max: "K" } })],
  ] satisfies [DataRequest, DataStore][]) {
    assert.equal((await resolveData(input, source)).available, false);
    await assert.rejects(queryData(input, source), QueryError);
  }
});
test("small regions with no centers and oversized periods fail explicitly", async () => {
  assert.equal((await resolveData({ ...request, region: { ...request.region, bbox: [140, -36, 140.1, -35.9] } }, store())).reason, "no_cell_centers");
  assert.equal((await resolveData({ ...request, period: { start: "2003-01-01", end: "2003-02-01" } }, store())).reason, "request_too_large");
});
test("metadata and stored cells must agree before publication to the caller", async () => {
  const source = store();
  source.tile = async () => ({ ...tile, cells: [1] });
  await assert.rejects(queryData(request, source), /does not match/);
});
test("inflated bounding boxes cannot turn partial affine coverage into a complete result", async () => {
  const source = store({}, [{ ...tile, width: 1, height: 1, cells: [42] }]);
  assert.equal((await resolveData(request, source)).reason, "unsupported_grid");
  await assert.rejects(queryData(request, source), QueryError);
});
