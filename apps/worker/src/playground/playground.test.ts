import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { checkChart, checkDataset, checkReport, loadSkills } from "./artifacts";
import { playgroundEnvironment, toLogEvent } from "./host";

const dataset = { name: "tmax", title: "T", columns: [{ name: "date" }, { name: "value", unit: "degC" }], provenance: [],
  rows: [{ date: "2004-01-01", value: 36.8 }, { date: "2004-01-02", value: null }] };

test("datasets keep nulls, reject undeclared columns, non-finite numbers and oversized tables", () => {
  assert.equal(checkDataset(dataset).rowCount, 2);
  assert.equal(checkDataset(dataset).rows[1]!.value, null);
  assert.throws(() => checkDataset({ ...dataset, rows: [{ date: "x", other: 1 }] }), /not declared/);
  assert.throws(() => checkDataset({ ...dataset, rows: [{ date: "x", value: Number.NaN }] }), /not finite/);
  assert.throws(() => checkDataset({ ...dataset, name: "Bad Name" }), /lowercase/);
  assert.throws(() => checkDataset({ ...dataset, rows: Array.from({ length: 5001 }, () => ({ date: "x" })) }), /At most/);
});

test("charts read only saved datasets and can never make the browser fetch a URL", () => {
  const saved = new Set(["tmax"]);
  const spec = { layer: [{ data: { name: "tmax" }, mark: "line" }, { transform: [{ lookup: "date", from: { data: { name: "tmax" }, key: "date" } }], mark: "rule" }] };
  assert.deepEqual(checkChart({ id: "trend", title: "T", spec }, saved).datasets, ["tmax"]);
  assert.throws(() => checkChart({ id: "x", title: "T", spec: { data: { url: "https://evil.example/a.csv" }, mark: "line" } }, saved), /url/);
  assert.throws(() => checkChart({ id: "x", title: "T", spec: { data: { name: "tmax" }, encoding: { href: { field: "date" } } } }, saved), /href/);
  assert.throws(() => checkChart({ id: "x", title: "T", spec: { data: { values: [{ a: 1 }] }, mark: "bar" } }, saved), /Inline data/);
  assert.throws(() => checkChart({ id: "x", title: "T", spec: { data: { name: "missing" }, mark: "bar" } }, saved), /not been saved/);
  assert.throws(() => checkChart({ id: "x", title: "T", spec: { mark: "bar" } }, saved), /at least one/);
});

test("report embeds that do not resolve are reported back to the agent", () => {
  const { warnings } = checkReport({ title: "R", markdown: "![a](chart:trend) ![b](dataset:tmax) ![c](chart:nope) ![d](https://x.example/i.png)" },
    new Set(["trend"]), new Set(["tmax"]));
  assert.deepEqual(warnings, ["chart:nope is not defined; it will render as missing.", "Only chart: and dataset: images are rendered; other images are removed."]);
});

test("Pi receives the model credential and the public MCP URL, never database or payment secrets", () => {
  const env = playgroundEnvironment("/tmp/session", "https://api.verdant-ai.com/mcp", "/skills", { ANTHROPIC_API_KEY: "k", SUPABASE_SECRET_KEY: "s",
    STRIPE_SECRET_KEY: "p", API_ADMIN_TOKEN: "a", PLAYGROUND_VOICE_SECRET: "v", PATH: "/bin" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "HOME", "PATH", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
    "PLAYGROUND_SKILLS_DIR", "VERDANT_MCP_URL"]);
  assert.equal(env.HOME, "/tmp/session");
});

test("Pi events map onto the session event log", () => {
  assert.deepEqual(toLogEvent({ type: "artifact", kind: "chart", data: { id: "c" } }), { kind: "chart", data: { id: "c" } });
  assert.equal(toLogEvent({ type: "artifact", kind: "user_message", data: {} }), null);
  assert.equal(toLogEvent({ type: "delta", text: "x" }), null);
});

test("the repository's methodology skills load by name", async () => {
  const skills = await loadSkills(path.resolve(import.meta.dirname, "../../../../skills"));
  assert.ok(skills.has("verdant-forecast-backtest"));
  assert.match(skills.get("verdant-perennial-economics")!.text, /Reference: studies\.md/);
});
