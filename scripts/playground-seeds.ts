// Playground seed questions and the published data each one needs. The playground analyst reaches data only through
// the read-only MCP (no acquisition), so every gridded window a seed depends on is acquired here ahead of time.
//   node --import tsx scripts/playground-seeds.ts [production|sandbox] [--check]
// --check only resolves coverage. Otherwise missing windows are queued with the operator token (no payment) and
// followed until they are ready. Windows are calendar months or one storm window, because a query cannot span versions.
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readEnv, root } from "./env-files.mjs";

type Variable = "air_temperature_max" | "air_temperature_min" | "precipitation_amount";
type Window = { variable: Variable; bbox: [number, number, number, number]; start: string; end: string };
export type Seed = { question: string; shows: string; grids: Window[]; datasets: string[] };

const units = { air_temperature_max: "degC", air_temperature_min: "degC", precipitation_amount: "mm" } as const;
const months = (variable: Variable, bbox: Window["bbox"], ...spans: [string, string][]) => spans.map(([start, end]) => ({ variable, bbox, start, end }));
// Around the CSIRO trial's published point (34°25′S, 142°21′E); acquisition snaps it to the 1° SILO block the query reads.
const vineyard: Window["bbox"] = [142.2, -34.6, 142.5, -34.25];
const summer2003: [string, string][] = [["2003-12-01", "2003-12-31"], ["2004-01-01", "2004-01-31"], ["2004-02-01", "2004-02-29"]];
const austin: Window["bbox"] = [-97.9, 30.15, -97.6, 30.4];

export const seeds: Seed[] = [
  {
    question: "Did the CSIRO vineyard near Mildura irrigate more during the hottest spells of summer 2003–04?",
    shows: "Joins dated trial irrigation records with SILO gridded heat and rain at the trial's published location.",
    grids: [...months("air_temperature_max", vineyard, ...summer2003), ...months("air_temperature_min", vineyard, ...summer2003),
      ...months("precipitation_amount", vineyard, ...summer2003)],
    datasets: ["csiro-wnra0305"],
  },
  {
    question: "How cold did Austin get during the February 2021 Texas freeze, and how many days never rose above freezing?",
    shows: "NOAA nClimGrid-Daily (1/24°, contiguous US): daily highs and lows through Winter Storm Uri.",
    grids: [...months("air_temperature_min", austin, ["2021-02-01", "2021-02-28"]), ...months("air_temperature_max", austin, ["2021-02-01", "2021-02-28"])],
    datasets: [],
  },
  {
    question: "How much rain fell on Houston during Hurricane Harvey, and which day was the worst?",
    shows: "NOAA nClimGrid-Daily precipitation over a 31-day window around landfall; storm totals and the wettest day.",
    grids: months("precipitation_amount", [-95.7, 29.5, -95.0, 30.1], ["2017-08-15", "2017-09-14"]),
    datasets: [],
  },
  {
    question: "How did the July 2022 heatwave compare across London, Paris and Madrid?",
    shows: "NOAA CPC Global Unified (0.5°, global land): the same variable and month in three countries.",
    grids: [[-0.5, 51.0, 0.5, 52.0], [2.0, 48.5, 3.0, 49.5], [-4.0, 40.0, -3.0, 41.0]]
      .flatMap(bbox => months("air_temperature_max", bbox as Window["bbox"], ["2022-07-01", "2022-07-31"])),
    datasets: [],
  },
  {
    question: "How reliable are the NWS day-two frost forecasts? Show their calibration.",
    shows: "Forecast verification: reliability of calibrated probabilities against observed frost at ASOS stations, 2010–2025.",
    grids: [], datasets: ["nws-future-day2-frost"],
  },
  {
    question: "Did higher nitrogen rates pay off in the Ohio corn trials?",
    shows: "Trial economics: yield response to nitrogen and partial margins at the recorded grain and fertilizer prices.",
    grids: [], datasets: ["ohio-nitrogen-trials"],
  },
];

const body = (w: Window) => ({ variables: [w.variable], region: { bbox: w.bbox, crs: "EPSG:4326" }, period: { start: w.start, end: w.end },
  temporal_resolution: "daily", spatial_resolution: "native", units: { [w.variable]: units[w.variable] }, data_class: "interpolated_observation",
  missing_policy: "preserve", source_preference: "auto" });
const label = (w: Window) => `${w.variable.replace("air_temperature_", "t").replace("precipitation_amount", "precip")} ${w.start}..${w.end} [${w.bbox.join(",")}]`;

async function main() {
  const profile = process.argv.find(a => a === "production" || a === "sandbox") ?? "production";
  const check = process.argv.includes("--check");
  const env = { ...await readEnv(path.join(root, profile === "production" ? ".env.production" : ".env.local")), ...process.env };
  const origin = env.API_ORIGIN, token = env.API_ADMIN_TOKEN;
  if (!origin || (!check && !token)) throw new Error(`API_ORIGIN${check ? "" : " and API_ADMIN_TOKEN"} must be set for ${profile}.`);
  const post = (route: string, payload: unknown, auth = false) => fetch(new URL(route, origin), { method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) });

  const catalog = await (await fetch(new URL("/api/v1/datasets", origin))).json() as { datasets: { dataset_key: string }[] };
  const keys = new Set(catalog.datasets.map(d => d.dataset_key));
  let missing = 0;
  for (const seed of seeds) for (const key of seed.datasets) if (!keys.has(key)) { missing++; console.log(`MISSING dataset ${key} (${seed.question})`); }

  const pending = new Map<string, Window>();
  for (const window of seeds.flatMap(s => s.grids)) {
    const resolved = await (await post("/api/v1/data/resolve", body(window))).json() as { available: boolean; selection?: { datasetVersion: string } };
    if (resolved.available) { console.log(`ready    ${label(window)} → ${resolved.selection!.datasetVersion}`); continue; }
    if (check) { missing++; console.log(`MISSING  ${label(window)}`); continue; }
    const response = await post("/api/v1/data/requests", body(window), true);
    const record = await response.json() as { id?: string; status?: string; datasetVersion?: string; error?: string; message?: string };
    if (response.status === 200 && record.status === "ready") console.log(`ready    ${label(window)} → ${record.datasetVersion}`);
    else if (record.id && [200, 202].includes(response.status)) { pending.set(record.id, window); console.log(`queued   ${label(window)} → ${record.id}`); }
    else { missing++; console.log(`FAILED   ${label(window)}: HTTP ${response.status} ${record.error ?? ""} ${record.message ?? ""}`); }
  }
  // Acquisitions run one at a time on the worker; follow them until each is ready or failed.
  while (pending.size) {
    await delay(10_000);
    for (const [id, window] of pending) {
      const record = await (await fetch(new URL(`/api/v1/data/requests/${id}`, origin))).json() as { status: string; datasetVersion?: string; error?: unknown };
      if (record.status === "ready") { pending.delete(id); console.log(`ready    ${label(window)} → ${record.datasetVersion}`); }
      else if (record.status === "failed") { pending.delete(id); missing++; console.log(`FAILED   ${label(window)}: ${JSON.stringify(record.error ?? record)}`); }
    }
  }
  console.log(missing ? `${missing} seed input(s) missing.` : `All ${seeds.length} seeds have their data published.`);
  process.exitCode = missing ? 1 : 0;
}

if (import.meta.main) await main();
