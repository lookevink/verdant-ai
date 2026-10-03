"use client";
import { useState } from "react";
import type { DataRequest } from "@verdant/contracts";
type Result = { run: number; status: number; text: string };
// Receives the example from the server so the schema library never ships to the browser.
export function RequestForm({ exampleRequest }: { exampleRequest: DataRequest }) {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [date, setDate] = useState(exampleRequest.period.start);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  async function validate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setResult(null);
    const run = Date.now();
    try {
      const response = await fetch("/api/v1/data/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...exampleRequest, format, period: { start: date, end: date } }),
      });
      const body: unknown = await response.json();
      setResult({ run, status: response.status, text: JSON.stringify(body, null, 2) });
    } catch { setResult({ run, status: 0, text: "The API is unavailable. Start apps/api on port 3001 and retry." }); }
    finally { setPending(false); }
  }
  const ok = result?.status === 200;
  return <form onSubmit={validate}>
    <label>Variable<input value="Daily maximum air temperature" readOnly /></label>
    <label>Region<input value="142.30, −34.45 → 142.40, −34.35 · WGS84" readOnly /></label>
    <div className="fields"><label>Date<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Delivery format<select value={format} onChange={e => setFormat(e.target.value as "csv" | "json")}><option value="csv">CSV</option><option value="json">JSON</option></select></label></div>
    <button className="button submit" disabled={pending} data-pending={pending || undefined}>
      <span>{pending ? "Validating…" : "Validate request"}</span><svg className="arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" /></svg>
    </button>
    <p className="hint">Checks the shared request contract. Does not charge or start a worker.</p>
    <div aria-live="polite">{result && <div className="output" key={result.run} data-ok={ok}>
      <p className="output-status"><i />{ok ? "Valid request structure" : result.status ? `Not valid · HTTP ${result.status}` : "API offline"}</p>
      <pre>{result.text.split("\n").map((line, i) => <span key={i} style={{ "--i": Math.min(i, 24) } as React.CSSProperties}>{line}{"\n"}</span>)}</pre>
    </div>}</div>
  </form>;
}
