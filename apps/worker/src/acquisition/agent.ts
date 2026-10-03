// Pi acquisition agent. Runs as a child process whose environment contains only the model credential:
// no Supabase, payment or worker secrets. Its only capabilities are the five acquisition tools below
// (no shell, file or web tools). Progress goes to the supervisor as JSON lines on file descriptor 3.
import { createWriteStream } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { modelSpec } from "./model";
import { describeTarget, fetchSource, inspectSource, normalizeSource, submitManifest, validateOutput, Workspace } from "./operations";

const thinkingLevels = ["off", "minimal", "low", "medium", "high"] as const;

function systemPrompt(ws: Workspace) {
  const t = describeTarget(ws);
  return `You are Verdant's climate data acquisition agent. Each job has exactly one target, and your tools perform all
network access, decoding and validation. You decide the order of operations and how to recover from failures.

Target: ${t.variable} in ${t.unit} from ${t.provider} ${t.product}, source variable "${t.sourceVariable}".
Dates: ${t.period.start} to ${t.period.end} inclusive (${t.days} days). Native ${t.grid.resolutionDegrees}° ${t.grid.crs} grid window:
column ${t.window.col}, row ${t.window.row}, ${t.window.width}×${t.window.height} cells; bounds ${t.bounds.join(", ")} (west, south, east, north).

Procedure:
1. inspect_source: confirm that every target date exists at the source.
2. fetch_source: download the target dates, batched in one call where possible. Retry failed dates once.
   If a date is confirmed missing or permanently unavailable, stop and explain. Never substitute another date.
3. normalize_source: crop and decode every fetched date.
4. validate_output: if a check fails, use its detail to repair the cause (for example re-fetch, then re-normalize) and validate again.
5. submit_manifest: once validation passes, submit with a short factual summary.

Rules: never invent, interpolate, rescale or alter values. Missing source cells stay missing. Do not change the target or
request dates outside it. If the target cannot be acquired, stop and state why. Keep messages brief.`;
}

function tools(ws: Workspace, signal: AbortSignal, budget: { calls: number }) {
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value as never });
  const guard = () => {
    if (++budget.calls > 40) throw new Error("Tool call budget exhausted. Stop and report the problem.");
  };
  const dates = Type.Array(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), { minItems: 1, maxItems: 31 });
  return [
    defineTool({ name: "inspect_source", label: "Inspect source", executionMode: "sequential",
      description: "List the source objects for every target date and report which dates are available. Read-only.",
      parameters: Type.Object({}), execute: async () => { guard(); return json(await inspectSource(ws, signal)); } }),
    defineTool({ name: "fetch_source", label: "Fetch source", executionMode: "sequential",
      description: "Download source GeoTIFFs for the given target dates from the public SILO bucket. Already verified files are reused.",
      parameters: Type.Object({ dates }), execute: async (_id, p) => { guard(); return json(await fetchSource(ws, p.dates, signal)); } }),
    defineTool({ name: "normalize_source", label: "Normalize source", executionMode: "sequential",
      description: "Decode fetched GeoTIFFs, check georeferencing, crop the target window and convert source nodata to null. Omit dates to normalize all target dates.",
      parameters: Type.Object({ dates: Type.Optional(dates) }), execute: async (_id, p) => { guard(); return json(await normalizeSource(ws, p.dates)); } }),
    defineTool({ name: "validate_output", label: "Validate output", executionMode: "sequential",
      description: "Run deterministic checks: complete period, canonical provenance, cell-for-cell reconciliation with source bytes, dimensions, finite and plausible values.",
      parameters: Type.Object({}), execute: async () => { guard(); return json(await validateOutput(ws)); } }),
    defineTool({ name: "submit_manifest", label: "Submit manifest", executionMode: "sequential",
      description: "Submit the validated acquisition for publication. Fails unless the latest validation passed and files are unchanged.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 1000 }) }),
      execute: async (_id, p) => { guard(); return json(await submitManifest(ws, p.summary)); } }),
  ];
}

const emptyResources = (prompt: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => prompt, getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
});

async function main(dir: string) {
  const channel = createWriteStream("", { fd: 3 });
  const emit = (event: Record<string, unknown>) => channel.write(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
  const ws = await Workspace.open(dir);
  const spec = modelSpec(), key = process.env.ANTHROPIC_API_KEY;
  if (spec.provider === "anthropic" && !key) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const runtime = await ModelRuntime.create({ authPath: ws.file(".pi", "auth.json"), modelsPath: null });
  if (key) await runtime.setRuntimeApiKey("anthropic", key);
  const base = runtime.getModel(spec.provider, spec.id);
  if (!base) throw new Error(`Model ${spec.label} is not available in this Pi version.`);
  // Organization-level keys must name a workspace on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  if (workspace && !/^wrkspc_[A-Za-z0-9]+$/.test(workspace)) throw new Error("ANTHROPIC_WORKSPACE_ID must look like wrkspc_….");
  const model = workspace && spec.provider === "anthropic" ? { ...base, headers: { ...base.headers, "anthropic-workspace-id": workspace } } : base;
  const thinking = thinkingLevels.find(l => l === process.env.PI_THINKING) ?? "low";
  const abort = new AbortController();
  const budget = { calls: 0 };
  const { session } = await createAgentSession({
    cwd: dir, agentDir: ws.file(".pi"), model, thinkingLevel: thinking, modelRuntime: runtime,
    resourceLoader: emptyResources(systemPrompt(ws)), sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3 } }),
    customTools: tools(ws, abort.signal, budget), tools: ["inspect_source", "fetch_source", "normalize_source", "validate_output", "submit_manifest"],
  });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };
  session.subscribe(event => {
    if (event.type === "tool_execution_start") emit({ type: "tool_start", tool: event.toolName, args: event.args });
    else if (event.type === "tool_execution_end") emit({ type: "tool_end", tool: event.toolName, ok: !event.isError,
      result: event.isError ? String(event.result?.content?.[0]?.text ?? "error").slice(0, 500) : event.result?.details });
    else if (event.type === "auto_retry_start") emit({ type: "model_retry", attempt: event.attempt, error: event.errorMessage.slice(0, 300) });
    else if (event.type === "message_end" && event.message.role === "assistant") {
      const m = event.message;
      usage.turns++; usage.input += m.usage.input; usage.output += m.usage.output; usage.cacheRead += m.usage.cacheRead;
      usage.cacheWrite += m.usage.cacheWrite; usage.costUsd += m.usage.cost.total;
      if (m.stopReason === "error") emit({ type: "model_error", error: (m.errorMessage ?? "unknown").slice(0, 300) });
    }
  });
  const submitted = async () => (await ws.readJson("manifest.json")) !== null;
  const timer = setTimeout(() => { abort.abort(); void session.abort(); }, Number(process.env.PI_TIMEOUT_MS) || 480_000);
  try {
    await session.prompt(`Acquire the target described in your instructions (acquisition ${ws.job.acquisitionId}, attempt ${ws.job.attempt}).`);
    // A model can stop early (for example after a transient tool error). Nudge it twice; never publish without a manifest.
    for (let nudge = 0; nudge < 2 && !(await submitted()) && !abort.signal.aborted && budget.calls < 40
      && !(await ws.readJson("permanent-failure.json")); nudge++) {
      emit({ type: "nudge", count: nudge + 1 });
      await session.prompt("submit_manifest has not succeeded. Continue the procedure from where it stopped, or state precisely why the target cannot be acquired.");
    }
  } finally {
    clearTimeout(timer);
    const last = session.getLastAssistantText()?.slice(0, 1000) ?? null;
    emit({ type: "result", submitted: await submitted(), model: spec.label, thinking, toolCalls: budget.calls, usage, finalMessage: last });
    session.dispose();
    channel.end();
  }
  return await submitted();
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error("Usage: agent.ts <job-directory>"); process.exit(2); }
  main(dir).then(ok => { process.exitCode = ok ? 0 : 3; }, error => { console.error((error as Error).message); process.exitCode = 1; });
}
