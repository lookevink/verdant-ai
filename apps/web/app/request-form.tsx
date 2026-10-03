"use client";
import { useState } from "react";
import type { DataRequest } from "@verdant/contracts";
type Result = { run: number; status: number; text: string; action: "query" | "validate" };
// Receives the example from the server so the schema library never ships to the browser.
export function RequestForm({ exampleRequest }: { exampleRequest: DataRequest }) {
  const [format, setFormat] = useState<"csv" | "json">("json");
  const [date, setDate] = useState(exampleRequest.period.start);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  async function runRequest(action: "query" | "validate") {
    setPending(true); setResult(null);
    const run = Date.now();
    try {
      const response = await fetch(`/api/v1/data/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...exampleRequest, format, period: { start: date, end: date } }),
      });
      const text = response.headers.get("content-type")?.includes("application/json")
        ? JSON.stringify(await response.json(), null, 2) : await response.text();
      setResult({ run, status: response.status, text, action });
    } catch { setResult({ run, status: 0, text: "The API is temporarily unavailable. Please try again.", action }); }
    finally { setPending(false); }
  }
  const ok = result?.status === 200;
  return <form onSubmit={event => { event.preventDefault(); void runRequest("query"); }}>
    <label>Variable<input value="Daily maximum air temperature" readOnly /></label>
    <label>Region<input value="142.30, −34.45 → 142.40, −34.35 · WGS84" readOnly /></label>
    <div className="fields"><label>Date<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Response format<select value={format} onChange={e => setFormat(e.target.value as "csv" | "json")}><option value="json">JSON</option><option value="csv">CSV</option></select></label></div>
    <button className="button submit" disabled={pending} data-pending={pending || undefined}>
      <span>{pending ? "Reading data…" : "Query data"}</span><svg className="arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" /></svg>
    </button>
    <button className="button ghost" type="button" disabled={pending} onClick={() => void runRequest("validate")}>Validate structure only</button>
    <p className="hint">Returns published data directly. Available date: 1 January 2003. Free demo; no purchase or acquisition.</p>
    <div aria-live="polite">{result && <div className="output" key={result.run} data-ok={ok}>
      <p className="output-status"><i />{ok ? result.action === "query" ? "Data returned with provenance" : "Valid request structure · coverage not checked" : result.status ? `Request could not be completed · HTTP ${result.status}` : "API offline"}</p>
      <pre>{result.text.split("\n").map((line, i) => <span key={i} style={{ "--i": Math.min(i, 24) } as React.CSSProperties}>{line}{"\n"}</span>)}</pre>
    </div>}</div>
  </form>;
}
