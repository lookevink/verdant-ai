// Test double for the Pi agent: runs the five acquisition tools in order without a model and speaks the
// same fd-3 protocol. Used only to exercise the supervisor, queue and publication path in tests.
import { createWriteStream } from "node:fs";
import { fetchSource, inspectSource, normalizeSource, submitManifest, validateOutput, Workspace } from "../src/acquisition/operations";

const channel = createWriteStream("", { fd: 3 });
const emit = (event: Record<string, unknown>) => channel.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
const ws = await Workspace.open(process.argv[2]!);
const steps: [string, () => Promise<unknown>][] = [
  ["inspect_source", () => inspectSource(ws)], ["fetch_source", () => fetchSource(ws, ws.dates())],
  ["normalize_source", () => normalizeSource(ws)], ["validate_output", () => validateOutput(ws)],
  ["submit_manifest", () => submitManifest(ws, "Scripted test agent; no model involved.")],
];
let calls = 0;
for (const [tool, run] of steps) {
  emit({ type: "tool_start", tool, args: {} }); calls++;
  try { emit({ type: "tool_end", tool, ok: true, result: await run() }); }
  catch (error) { emit({ type: "tool_end", tool, ok: false, result: (error as Error).message }); break; }
}
const submitted = (await ws.readJson("manifest.json")) !== null;
emit({ type: "result", submitted, model: "test/scripted", toolCalls: calls, usage: {}, finalMessage: null });
channel.end();
process.exitCode = submitted ? 0 : 3;
