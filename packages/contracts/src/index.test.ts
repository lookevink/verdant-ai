import test from "node:test";
import assert from "node:assert/strict";
import { dataRequestSchema, exampleRequest } from "./index.js";

test("accepts the bounded demo contract", () => {
  assert.equal(dataRequestSchema.parse(exampleRequest).format, "csv");
});
test("rejects invalid calendar dates and reversed periods", () => {
  for (const period of [
    { start: "2003-02-30", end: "2003-03-01" },
    { start: "2003-01-03", end: "2003-01-02" },
  ]) assert.equal(dataRequestSchema.safeParse({ ...exampleRequest, period }).success, false);
});
test("rejects reversed bounds, unknown format, and hidden request fields", () => {
  assert.equal(dataRequestSchema.safeParse({ ...exampleRequest,
    region: { ...exampleRequest.region, bbox: [143, -35, 142, -34] } }).success, false);
  assert.equal(dataRequestSchema.safeParse({ ...exampleRequest, format: "netcdf" }).success, false);
  assert.equal(dataRequestSchema.safeParse({ ...exampleRequest, source_url: "http://localhost" }).success, false);
});
