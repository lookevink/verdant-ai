// Stand-in for the playground Pi agent in supervisor tests: the same stdin/fd 3 protocol, canned events, no model.
// A prompt containing "slow" waits for an abort; "crash" exits mid-turn.
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const channel = createWriteStream("", { fd: 3 });
const emit = (event: Record<string, unknown>) => channel.write(JSON.stringify(event) + "\n");
const dataset = { name: "tmax", title: "Daily maximum temperature", columns: [{ name: "date" }, { name: "tmax_c", unit: "degC" }],
  rows: [{ date: "2004-01-01", tmax_c: 36.8 }, { date: "2004-01-02", tmax_c: null }], rowCount: 2, provenance: [{ datasetVersion: "silo-test" }] };
let aborted: (() => void) | null = null;
emit({ type: "ready", model: "scripted", tools: ["codemode"] });
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const command = JSON.parse(line) as { type: string; seq: number; text: string; history?: unknown[] };
  if (command.type === "abort") aborted?.(); else void turn(command);
});
await new Promise(resolve => lines.once("close", resolve));
channel.end();

async function turn(command: { seq: number; text: string; history?: unknown[] }) {
  const started = Date.now();
  if (command.text.includes("crash")) process.exit(9);
  if (command.text.includes("slow")) {
    emit({ type: "tool_start", id: "t0", tool: "codemode", label: "Run analysis script", input: "await new Promise(() => {})" });
    await new Promise<void>(resolve => { aborted = resolve; });
    emit({ type: "turn_end", seq: command.seq, ok: false, reason: "cancelled", reply: "", durationMs: Date.now() - started });
    return;
  }
  for (const word of ["Looking ", "at ", "January."]) emit({ type: "delta", text: word });
  emit({ type: "message", text: "Looking at January." });
  emit({ type: "tool_start", id: "t1", tool: "codemode", label: "Run analysis script", input: "return 1" });
  emit({ type: "tool_start", id: "t2", parent: "t1", tool: "save_dataset", label: "Save dataset · tmax", input: "{}" });
  emit({ type: "artifact", kind: "dataset", data: dataset });
  emit({ type: "tool_end", id: "t2", parent: "t1", tool: "save_dataset", ok: true, summary: "{}" });
  emit({ type: "tool_end", id: "t1", tool: "codemode", ok: true, summary: "Script completed" });
  emit({ type: "artifact", kind: "chart", data: { id: "trend", title: "Trend", spec: { data: { name: "tmax" }, mark: "line" }, datasets: ["tmax"] } });
  emit({ type: "artifact", kind: "report", data: { title: "January", markdown: `# January\n\nHistory entries: ${command.history?.length ?? 0}\n\n![Trend](chart:trend)` } });
  emit({ type: "turn_end", seq: command.seq, ok: true, reply: `Answered: ${command.text}`, usage: { turns: 1 }, durationMs: Date.now() - started });
}
