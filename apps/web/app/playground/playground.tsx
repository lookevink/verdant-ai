"use client";
import dynamic from "next/dynamic";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { PlaygroundEvent, PlaygroundReport } from "@verdant/contracts/playground";
import { cancelTurn, createSession, followEvents, PlaygroundError, savedSession, saveSession, sendMessage, voiceTicket, type Session } from "./session";
import { Sprout, type Mood } from "./sprout";
import { apply, emptyView, reasons, type Step, type Turn, type View } from "./state";
import { VoiceClient } from "./voice";

const Report = dynamic(() => import("./report").then(m => m.Report), { ssr: false, loading: () => <p className="pg-quiet">Preparing the report…</p> });
const DatasetTable = dynamic(() => import("./report").then(m => m.DatasetTable), { ssr: false });

const suggestions = [
  "What were the hottest and coolest days near Mildura in January 2004?",
  "How reliable are the NWS day-two frost forecasts? Show their calibration.",
  "Did higher nitrogen rates pay off in the Ohio corn trials?",
  "Which irrigation program worked best in the CSIRO wine-grape trial?",
];
const errors: Record<string, string> = {
  session_limit_reached: "This network has started the maximum number of sessions today.", turn_limit_reached: "This session has reached its question limit. Start a new session.",
  session_closed: "This session has ended. Start a new one.", access_code_required: "Enter the playground access code.", voice_unavailable: "Voice isn't configured on this server.",
  invalid_ticket: "The voice connection expired. Try again.", vertex_unavailable: "The voice service is unavailable right now.", relay_busy: "Voice is busy right now. Try again shortly.",
  session_time_limit: "Voice sessions last up to 30 minutes. Turn voice on again to continue.",
};
const explain = (error: unknown) => errors[error instanceof PlaygroundError ? error.code : String(error)] ?? "Verdant is unavailable right now. Try again shortly.";
const seconds = (ms?: number) => ms === undefined ? "" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round(ms % 60_000 / 1000)} s`;
const modelName = (model?: string) => model?.replace(/^anthropic\//, "").replace(/^claude-(\w+)-(\d+)-(\d+)$/, (_, n: string, a, b) => `Claude ${n[0]!.toUpperCase()}${n.slice(1)} ${a}.${b}`);

export function Playground() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, dispatch] = useReducer((v: View, e: PlaygroundEvent | null) => e ? apply(v, e) : emptyView, emptyView);
  const [status, setStatus] = useState("idle");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState("");
  const [tab, setTab] = useState<"report" | "data">("report");
  const [pane, setPane] = useState<"chat" | "report">("chat");
  const [voice, setVoice] = useState<"off" | "connecting" | "on">("off");
  const [muted, setMuted] = useState(false);
  const [microphone, setMicrophone] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [cheer, setCheer] = useState<Mood | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const voiceRef = useRef<VoiceClient | null>(null);
  const sproutRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const narrated = useRef(new Set<number>());
  const followedAt = useRef(0);
  sessionRef.current = session;

  useEffect(() => { const saved = savedSession(); if (saved) setSession(saved); }, []);
  useEffect(() => {
    dispatch(null);
    if (!session) return;
    const abort = new AbortController();
    followedAt.current = Date.now();
    void followEvents(session, { event: dispatch, status: s => setStatus(s.status), lost: () => { saveSession(null); setSession(null); } }, abort.signal);
    return () => abort.abort();
  }, [session]);
  useEffect(() => () => voiceRef.current?.stop(), []);

  const running = view.turns.some(t => t.status === "running" || t.status === "queued");
  const last = view.turns.at(-1);
  // Keep the newest work in view unless the reader has scrolled up.
  useEffect(() => {
    const log = logRef.current;
    if (log && view.turns.length && log.scrollHeight - log.scrollTop - log.clientHeight < 240) log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  }, [view.lastSeq]);
  // A finished turn: a moment of delight (or concern), a read-aloud answer when voice is on, and the report brought forward.
  useEffect(() => {
    if (!last || !["done", "failed"].includes(last.status) || narrated.current.has(last.seq)) return;
    narrated.current.add(last.seq);
    // Replayed history (a reload) is neither celebrated nor read aloud again.
    if ((last.finishedAt ?? 0) < followedAt.current - 5000) return;
    setCheer(last.status === "done" ? "happy" : "sad");
    const timer = setTimeout(() => setCheer(null), 2600);
    if (last.status === "done" && last.reply) voiceRef.current?.narrate(last.reply);
    return () => clearTimeout(timer);
  }, [last?.seq, last?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    try {
      const created = await createSession(code.trim() || undefined);
      saveSession(created); setSession(created); setNeedsCode(false); setNotice(null);
      sessionRef.current = created;
      return created;
    } catch (error) {
      if (error instanceof PlaygroundError && error.code === "access_code_required") setNeedsCode(true);
      setNotice(explain(error));
      return null;
    }
  }
  async function ask(text: string, source: "text" | "voice" = "text") {
    const value = text.trim();
    if (!value) return false;
    const current = await ensureSession();
    if (!current) return false;
    try { await sendMessage(current, value, source); setNotice(null); return true; }
    catch (error) {
      if (error instanceof PlaygroundError && error.status === 404) { saveSession(null); setSession(null); }
      setNotice(explain(error)); return false;
    }
  }
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (await ask(draft)) setDraft("");
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  function reset() {
    voiceRef.current?.stop();
    saveSession(null); setSession(null); setStatus("idle"); setNotice(null); setTab("report"); setPane("chat");
    narrated.current.clear();
  }

  async function toggleVoice() {
    if (voiceRef.current) { voiceRef.current.stop(); voiceRef.current = null; setVoice("off"); return; }
    const current = await ensureSession();
    if (!current) return;
    setVoice("connecting"); setNotice(null);
    const client = new VoiceClient({
      state: (state, reason) => {
        if (state === "ready") setVoice("on");
        if (state === "closed") {
          if (voiceRef.current === client) voiceRef.current = null;
          setVoice("off"); setSpeaking(false); setHeard("");
          if (reason && !["browser_closed", "upstream_closed_1000"].includes(reason)) setNotice(errors[reason] ?? "The voice connection closed.");
        }
      },
      microphone: setMicrophone,
      userTranscript: (text, finished) => { setHeard(h => (h + text).slice(-240)); if (finished) setTimeout(() => setHeard(""), 2500); },
      sproutTranscript: text => setSaid(s => (s + text).slice(-400)),
      speaking: on => { setSpeaking(on); if (on) { setSaid(""); setHeard(""); } },
      toolCall: async call => {
        const active = sessionRef.current;
        if (call.name === "ask_verdant") {
          const question = String(call.args.question ?? "").trim();
          if (!active || !question) return { status: "error", retryable: false, message: "No question was given; ask the user what they would like to know." };
          return await ask(question, "voice")
            ? { status: "submitted", retryable: false, message: "The analyst is working on it. Tell the user in a few words; the answer will arrive as an ANALYST RESULT." }
            : { status: "error", retryable: false, message: "The question could not be submitted. Tell the user to try again." };
        }
        if (call.name === "stop_analysis" && active) {
          await cancelTurn(active).catch(() => {});
          return { status: "stopped", retryable: false, message: "The analysis was stopped." };
        }
        return { status: "error", retryable: false, message: "Unknown tool." };
      },
    }, () => sproutRef.current);
    voiceRef.current = client;
    try {
      await client.start(await voiceTicket(current));
      client.setMuted(muted);
    } catch (error) {
      client.stop(); voiceRef.current = null; setVoice("off");
      setNotice(error instanceof PlaygroundError ? explain(error) : "Voice could not start in this browser.");
    }
  }
  function toggleMute() { const next = !muted; setMuted(next); voiceRef.current?.setMuted(next); }

  const mood: Mood = speaking ? "speaking" : cheer ?? (running ? "thinking" : heard ? "listening" : voice === "on" && microphone && !muted ? "listening" : "idle");
  const line = speaking || said ? said : running ? "Gathering evidence…"
    : voice === "on" ? (!microphone ? "I can't hear you (no microphone access), but I'll read answers aloud." : muted ? "Microphone off. Type, or unmute to talk." : "I'm listening.")
    : voice === "connecting" ? "Waking up…" : view.turns.length ? "Ask a follow-up, or open the report." : "Hi! Ask me about Verdant's climate and farm data.";
  const datasets = Object.values(view.datasets);

  return <div className="pg">
    <header className="pg-nav">
      <a className="pg-brand" href="/"><svg className="mark" viewBox="0 0 32 32" aria-hidden="true"><path className="mark-stem" d="M16 30V14" /><path className="mark-leaf" d="M16 19C16 12 11.5 7.5 4 7.5 4 15 8.5 19 16 19Z" /><path className="mark-leaf mark-leaf-r" d="M16 15.5C16 9 20 4.5 27.5 4.5 27.5 11 23.5 15.5 16 15.5Z" /></svg>verdant<span>Playground</span></a>
      <div className="pg-nav-meta">
        {view.agent && <span className="pg-agent" data-state={view.agent.state}><i />{view.agent.state === "ready" ? `Pi · ${modelName(view.agent.model) ?? "ready"}` : view.agent.state === "starting" ? "Starting Pi…" : "Pi resting"}</span>}
        {session && <button type="button" className="pg-chip-button" onClick={reset}>New session</button>}
      </div>
    </header>

    <main className="pg-main" data-pane={pane}>
      <section className="pg-chat" aria-label="Conversation">
        <div className="pg-stage" data-empty={view.turns.length === 0 || undefined}>
          <Sprout ref={sproutRef} mood={mood} size={view.turns.length ? 112 : 176} />
          <div className="pg-bubble" aria-live="polite">{line}{heard && <span className="pg-heard">You: “{heard}”</span>}</div>
        </div>

        <div className="pg-log" ref={logRef}>
          {view.turns.length === 0
            ? <div className="pg-intro">
                <p>Ask in plain language. Verdant's analyst finds the published datasets that fit, gathers and processes the data in a sandbox, and writes up its methodology with charts and equations.</p>
                <ul className="pg-suggestions">{suggestions.map(s => <li key={s}><button type="button" onClick={() => void ask(s)}>{s}</button></li>)}</ul>
              </div>
            : view.turns.map(turn => <TurnView key={turn.seq} turn={turn} onOpenReport={() => { setTab("report"); setPane("report"); }} />)}
        </div>

        {needsCode && <form className="pg-code" onSubmit={e => { e.preventDefault(); void ensureSession(); }}>
          <label>Access code<input value={code} onChange={e => setCode(e.target.value)} autoComplete="off" /></label><button className="pg-chip-button">Continue</button>
        </form>}
        {notice && <p className="pg-notice" role="status">{notice}</p>}
        <form className="pg-composer" onSubmit={submit}>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} rows={1} maxLength={4000}
            placeholder={voice === "on" ? "Talk to Sprout, or type here…" : "Ask about climate, forecasts, trials…"} aria-label="Your question" />
          <div className="pg-composer-actions">
            <button type="button" className="pg-voice" data-state={voice} onClick={() => void toggleVoice()} aria-pressed={voice !== "off"}
              title={voice === "off" ? "Talk with Sprout (Gemini Live voice)" : "Turn voice off"}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg>
              <span>{voice === "off" ? "Voice" : voice === "connecting" ? "Connecting" : "Voice on"}</span>
            </button>
            {voice === "on" && microphone && <button type="button" className="pg-icon" onClick={toggleMute} aria-pressed={muted} title={muted ? "Unmute microphone" : "Mute microphone"}>{muted ? "Unmute" : "Mute"}</button>}
            {running && session && <button type="button" className="pg-icon" onClick={() => void cancelTurn(session).catch(() => {})}>Stop</button>}
            <button className="pg-send" disabled={!draft.trim()} aria-label="Send"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" /></svg></button>
          </div>
        </form>
      </section>

      <section className="pg-panel" aria-label="Report and data">
        <div className="pg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "report"} onClick={() => setTab("report")}>Report</button>
          <button role="tab" aria-selected={tab === "data"} onClick={() => setTab("data")}>Data{datasets.length > 0 && <b>{datasets.length}</b>}</button>
          {view.report && <button type="button" className="pg-download" onClick={() => downloadMarkdown(view.report!)}>Download .md</button>}
        </div>
        <div className="pg-panel-body">
          {tab === "report"
            ? view.report ? <Report key={view.report.version} report={view.report} artifacts={view} />
              : <Placeholder running={running} />
            : datasets.length ? <div className="pg-datasets">{datasets.map(d => <DatasetTable key={d.name} dataset={d} rows={20} />)}</div>
              : <p className="pg-quiet">Tables the analyst saves appear here, with their provenance and full CSV or JSON downloads.</p>}
        </div>
      </section>
    </main>
    <nav className="pg-switch" aria-label="Pane">
      <button aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>Conversation</button>
      <button aria-pressed={pane === "report"} onClick={() => setPane("report")}>Report{view.report ? " ●" : ""}</button>
    </nav>
  </div>;
}

function downloadMarkdown(report: PlaygroundReport) {
  const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report"}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Placeholder({ running }: { running: boolean }) {
  return <div className="pg-placeholder" data-running={running || undefined}>
    <p className="pg-eyebrow">{running ? "Working" : "Report"}</p>
    <h2>{running ? <>Gathering evidence <em>with care.</em></> : <>Answers, <em>with their evidence.</em></>}</h2>
    <ol>{["Answer", "Data and provenance", "Methodology and equations", "Results with charts", "Limitations"].map((s, i) => <li key={s} style={{ "--i": i } as React.CSSProperties}>{s}</li>)}</ol>
  </div>;
}

function TurnView({ turn, onOpenReport }: { turn: Turn; onOpenReport(): void }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const live = turn.status === "running";
  const expanded = open ?? live;
  const count = Object.keys(turn.steps).length;
  const hasWork = turn.timeline.length > 0 || turn.draft || live;
  return <article className="pg-turn" data-status={turn.status}>
    <p className="pg-user">{turn.source === "voice" && <span className="pg-said">Said</span>}{turn.text}</p>
    {turn.status === "queued" && <p className="pg-quiet pg-wait">Waking the analyst…</p>}
    {hasWork && <div className="pg-work" data-open={expanded || undefined}>
      <button type="button" className="pg-work-toggle" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="pg-spinner" data-live={live || undefined} />
        {live ? "Working" : `Worked for ${seconds(turn.durationMs)}`} · {count} step{count === 1 ? "" : "s"}
        {turn.usage && turn.usage.costUsd > 0 && <span className="pg-cost">${turn.usage.costUsd.toFixed(2)}</span>}
      </button>
      {expanded && <ol className="pg-trail">
        {turn.timeline.map((entry, i) => entry.type === "note" ? <li key={i} className="pg-note">{entry.text}</li>
          : turn.steps[entry.id] ? <StepView key={entry.id} step={turn.steps[entry.id]!} steps={turn.steps} /> : null)}
        {turn.draft && <li className="pg-note" data-streaming>{turn.draft}</li>}
      </ol>}
    </div>}
    {turn.reply && <div className="pg-reply"><p>{turn.reply}</p>{turn.artifacts.includes("report") && <button type="button" className="pg-link" onClick={onOpenReport}>Open the report →</button>}</div>}
    {(turn.status === "failed" || turn.status === "cancelled") && <p className="pg-turn-error">{reasons[turn.reason ?? ""] ?? "This question could not be answered."}</p>}
  </article>;
}

const kind = (tool: string) => tool === "codemode" ? "Script" : tool.startsWith("mcp__") ? "MCP" : ["save_dataset", "render_chart", "write_report"].includes(tool) ? "Output" : tool === "read_skill" ? "Guide" : "Tool";
/** One tool step. Scripts show their source; runs of the same nested call collapse into one row. */
function StepView({ step, steps }: { step: Step; steps: Record<string, Step> }) {
  const [open, setOpen] = useState(false);
  const children = step.children.map(id => steps[id]).filter((s): s is Step => Boolean(s));
  const groups: Step[][] = [];
  for (const child of children) {
    const group = groups.at(-1);
    if (group && group[0]!.tool === child.tool) group.push(child); else groups.push([child]);
  }
  const detail = step.tool === "codemode" ? step.input : step.input && step.input !== "{}" ? step.input : undefined;
  return <li className="pg-step" data-status={step.status}>
    <button type="button" className="pg-step-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!detail && !step.summary}>
      <i className="pg-dot" /><span className="pg-kind">{kind(step.tool)}</span><span className="pg-label">{step.label}</span>
    </button>
    {open && <div className="pg-step-body">
      {detail && <pre data-lang={step.tool === "codemode" ? "js" : "json"}>{detail}</pre>}
      {step.summary && <pre className="pg-result">{step.summary}</pre>}
    </div>}
    {groups.length > 0 && <ol className="pg-children">{groups.map(group => group.length >= 3
      ? <GroupView key={group[0]!.id} group={group} steps={steps} />
      : group.map(child => <StepView key={child.id} step={child} steps={steps} />))}</ol>}
  </li>;
}
function GroupView({ group, steps }: { group: Step[]; steps: Record<string, Step> }) {
  const [open, setOpen] = useState(false);
  const failed = group.filter(s => s.status === "failed").length, running = group.some(s => s.status === "running");
  return <li className="pg-step" data-status={running ? "running" : failed ? "failed" : "done"}>
    <button type="button" className="pg-step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <i className="pg-dot" /><span className="pg-kind">{kind(group[0]!.tool)}</span>
      <span className="pg-label">{group[0]!.label.split(" · ")[0]} <b>×{group.length}</b>{failed > 0 && ` · ${failed} failed`}</span>
    </button>
    {open && <ol className="pg-children">{group.map(s => <StepView key={s.id} step={s} steps={steps} />)}</ol>}
  </li>;
}
