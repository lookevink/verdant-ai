// Validation for what the playground agent publishes to the browser: datasets, Vega-Lite charts and the report.
// Everything here is deterministic and runs inside the Pi process, so a bad artifact is rejected with an error the
// model can act on before anything reaches the event log.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { playgroundLimits, type PlaygroundChart, type PlaygroundDataset, type PlaygroundReport } from "@verdant/contracts/playground";

export const artifactName = /^[a-z0-9][a-z0-9_-]{0,47}$/;
type Cell = string | number | boolean | null;

export class ArtifactError extends Error {}

export function checkDataset(input: Omit<PlaygroundDataset, "rowCount">): PlaygroundDataset {
  if (!artifactName.test(input.name)) throw new ArtifactError("name must be 1–48 lowercase letters, digits, '-' or '_'.");
  const names = new Set(input.columns.map(c => c.name));
  if (names.size !== input.columns.length) throw new ArtifactError("Column names must be unique.");
  if (input.rows.length > playgroundLimits.maxDatasetRows) throw new ArtifactError(`At most ${playgroundLimits.maxDatasetRows} rows; aggregate or filter first.`);
  input.rows.forEach((row, i) => {
    for (const [key, value] of Object.entries(row)) {
      if (!names.has(key)) throw new ArtifactError(`Row ${i} has column "${key}", which is not declared in columns.`);
      if (typeof value === "number" && !Number.isFinite(value)) throw new ArtifactError(`Row ${i} column "${key}" is not finite; use null for missing values.`);
    }
  });
  const dataset = { ...input, rows: input.rows as Record<string, Cell>[], rowCount: input.rows.length };
  if (Buffer.byteLength(JSON.stringify(dataset)) > playgroundLimits.maxDatasetBytes) throw new ArtifactError("Dataset exceeds 1 MB; keep only the columns and rows the answer needs.");
  return dataset;
}

/** Charts may only read saved datasets: no URLs (the browser must not fetch anything a spec names) and no inline values. */
export function checkChart(input: Omit<PlaygroundChart, "datasets">, saved: ReadonlySet<string>): PlaygroundChart {
  if (!artifactName.test(input.id)) throw new ArtifactError("id must be 1–48 lowercase letters, digits, '-' or '_'.");
  const datasets = new Set<string>();
  const visit = (value: unknown, key: string) => {
    if (Array.isArray(value)) return value.forEach(v => visit(v, key));
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "url" || k === "href") throw new ArtifactError(`"${k}" is not allowed in chart specs; reference saved datasets by name.`);
      if (k === "data" && v && typeof v === "object" && !Array.isArray(v)) {
        const data = v as Record<string, unknown>;
        if ("values" in data) throw new ArtifactError("Inline data values are not allowed; save the table with save_dataset and use {\"name\": ...}.");
        if (typeof data.name === "string") {
          if (!saved.has(data.name)) throw new ArtifactError(`Dataset "${data.name}" has not been saved in this session.`);
          datasets.add(data.name);
        }
      }
      visit(v, k);
    }
  };
  visit(input.spec, "");
  if (datasets.size === 0) throw new ArtifactError("The spec must read at least one saved dataset through data: {\"name\": \"…\"}.");
  if (Buffer.byteLength(JSON.stringify(input.spec)) > 64_000) throw new ArtifactError("Chart spec exceeds 64 KB.");
  return { ...input, datasets: [...datasets] };
}

/** Returns the report plus warnings for embeds that do not resolve, so the model can fix them. */
export function checkReport(input: PlaygroundReport, charts: ReadonlySet<string>, saved: ReadonlySet<string>) {
  if (input.markdown.length > playgroundLimits.maxReportChars) throw new ArtifactError(`The report exceeds ${playgroundLimits.maxReportChars} characters.`);
  const warnings: string[] = [];
  for (const [, kind, name] of input.markdown.matchAll(/!\[[^\]]*\]\((chart|dataset):([^)\s]+)\)/g))
    if (!(kind === "chart" ? charts : saved).has(name!)) warnings.push(`${kind}:${name} is not defined; it will render as missing.`);
  if (/!\[[^\]]*\]\((?!chart:|dataset:)/.test(input.markdown)) warnings.push("Only chart: and dataset: images are rendered; other images are removed.");
  return { report: input, warnings };
}

/** Methodology guides from the repository's agent skills, readable by name. */
export async function loadSkills(dir: string | undefined) {
  const skills = new Map<string, { description: string; text: string }>();
  if (!dir) return skills;
  for (const name of (await readdir(dir).catch(() => [])).filter(n => /^verdant-[a-z-]+$/.test(n))) {
    const main = await readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => null);
    if (!main) continue;
    const references = await readdir(path.join(dir, name, "references")).catch(() => []);
    const extra = await Promise.all(references.filter(f => f.endsWith(".md")).map(async f => `\n\n---\nReference: ${f}\n\n` + await readFile(path.join(dir, name, "references", f), "utf8")));
    skills.set(name, { description: /^description:\s*(.+)$/m.exec(main)?.[1]?.trim() ?? "", text: main + extra.join("") });
  }
  return skills;
}
