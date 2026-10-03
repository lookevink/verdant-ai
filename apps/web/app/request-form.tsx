"use client";
import { useState } from "react";
import { exampleRequest } from "@verdant/contracts";
export function RequestForm() {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [date, setDate] = useState(exampleRequest.period.start);
  const [output, setOutput] = useState("");
  const [pending, setPending] = useState(false);
  async function validate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setOutput("");
    try {
      const response = await fetch("/api/v1/data/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...exampleRequest, format, period: { start: date, end: date } }),
      });
      const result: unknown = await response.json();
      setOutput(JSON.stringify(result, null, 2));
    } catch { setOutput("The API is unavailable. Start apps/api on port 3001 and retry."); }
    finally { setPending(false); }
  }
  return <form onSubmit={validate}>
    <label>Variable<input value="Daily maximum air temperature" readOnly /></label>
    <label>Region<input value="142.30, −34.45 → 142.40, −34.35 · WGS84" readOnly /></label>
    <div className="fields"><label>Date<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Delivery format<select value={format} onChange={e => setFormat(e.target.value as "csv" | "json")}><option value="csv">CSV</option><option value="json">JSON</option></select></label></div>
    <button disabled={pending}>{pending ? "Validating…" : "Validate request →"}</button>
    <p className="hint">Checks the shared request contract. Does not charge or start a worker.</p>
    {output && <pre aria-live="polite">{output}</pre>}
  </form>;
}
