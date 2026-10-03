import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquisitionTargetSchema, ACQUISITION_TRANSFORM_VERSION } from "@verdant/contracts/acquisition";
import { fetchSource, normalizeSource, submitManifest, validateOutput, Workspace } from "./operations";
import { decodeWindow, download, float32, sourceUrl } from "./silo";
import { agentEnvironment } from "./supervisor";

// Published production tile silo-tmax-20030101-e165b22947cfbbc5/mildura (source window 560,440,81,81).
const mildura = acquisitionTargetSchema.parse({ source: "silo", variable: "air_temperature_max", sourceVariable: "max_temp", unit: "degC",
  period: { start: "2003-01-01", end: "2003-01-01" }, window: { col: 560, row: 440, width: 81, height: 81 },
  bbox: [139.975, -36.025, 144.025, -31.975], transformVersion: ACQUISITION_TRANSFORM_VERSION });
const publishedCellsSha256 = "0000e879786ee1ff7fc56f39314e6686a401bd86365e3f17eab402c7831d5473";

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
  assert.equal(float32(Math.fround(43.6)), 43.6);
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
    assert.equal(report.checks.find(c => c.name === "period_complete")?.passed, false);
    await assert.rejects(submitManifest(ws, "done"), /has not passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("only canonical SILO objects are addressable", () => {
  assert.equal(sourceUrl("max_temp", "2003-01-01"), "https://s3-ap-southeast-2.amazonaws.com/silo-open-data/Official/daily/max_temp/2003/20030101.max_temp.tif");
  assert.throws(() => sourceUrl("../max_temp", "2003-01-01"));
});

// Network: VERDANT_NETWORK_TESTS=1 pnpm --filter @verdant/worker test
test("reproduces the published Mildura tile from the live SILO source", { skip: !process.env.VERDANT_NETWORK_TESTS }, async () => {
  const source = await download("max_temp", "2003-01-01");
  assert.equal(source.sha256, "f820ad5980b887705f7d4147d767c1b0585811cecf281ada591e6383fb27b3f9");
  const decoded = await decodeWindow(source.body, mildura);
  assert.equal(createHash("sha256").update(JSON.stringify(decoded.cells)).digest("hex"), publishedCellsSha256);
  assert.equal(decoded.stats.missing, 0);
  const dir = await mkdtemp(path.join(tmpdir(), "verdant-acq-"));
  try {
    const ws = await Workspace.create(dir, { acquisitionId: "test", attempt: 1, target: mildura });
    assert.deepEqual((await fetchSource(ws, ["2003-01-01"])).failed, []);
    assert.deepEqual((await normalizeSource(ws)).failed, []);
    const report = await validateOutput(ws);
    assert.ok(report.passed, JSON.stringify(report.checks));
    assert.equal((await submitManifest(ws, "test")).submitted, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("legacy ocean sentinel (-3276.8) becomes null only as the full SILO ocean mask", { skip: !process.env.VERDANT_NETWORK_TESTS }, async () => {
  const melbourne = { ...mildura, period: { start: "1900-01-01", end: "1900-01-01" }, window: { col: 640, row: 540, width: 40, height: 20 },
    bbox: [143.975, -37.975, 145.975, -36.975] as [number, number, number, number] };
  const { cells, stats } = await decodeWindow((await download("max_temp", "1900-01-01")).body, melbourne);
  assert.equal(stats.nodataEncoding, "legacy_scaled");
  assert.equal(stats.missing, 5); // Port Phillip Bay
  assert.equal(stats.implausible, 0);
  assert.ok(cells.every(v => v === null || v > -20));
});
