"use client";
import "katex/dist/katex.min.css";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PlaygroundChart, PlaygroundDataset, PlaygroundReport } from "@verdant/contracts/playground";
import { VegaChart } from "./chart";

type Artifacts = { datasets: Record<string, PlaygroundDataset>; charts: Record<string, PlaygroundChart> };

const csvCell = (value: unknown) => value === null || value === undefined ? "" : `"${String(value).replace(/"/g, '""')}"`;
export function download(dataset: PlaygroundDataset, format: "csv" | "json") {
  const body = format === "csv"
    ? [dataset.columns.map(c => csvCell(c.name)).join(","), ...dataset.rows.map(row => dataset.columns.map(c => csvCell(row[c.name])).join(","))].join("\r\n") + "\r\n"
    : JSON.stringify(dataset, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${dataset.name}.${format}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const format = (value: unknown) => value === null || value === undefined ? "—" : typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value);
/** A saved table: first rows, units in the header, provenance, and CSV/JSON downloads of every row. */
export function DatasetTable({ dataset, rows = 12 }: { dataset: PlaygroundDataset; rows?: number }) {
  return <figure className="pg-dataset">
    <div className="pg-dataset-head">
      <div><strong>{dataset.title}</strong><span>{dataset.rowCount.toLocaleString()} rows · {dataset.columns.length} columns</span></div>
      <div className="pg-dataset-actions"><button type="button" onClick={() => download(dataset, "csv")}>CSV</button><button type="button" onClick={() => download(dataset, "json")}>JSON</button></div>
    </div>
    <div className="pg-table-wrap"><table>
      <thead><tr>{dataset.columns.map(c => <th key={c.name} title={c.description}>{c.label ?? c.name}{c.unit && <small>{c.unit}</small>}</th>)}</tr></thead>
      <tbody>{dataset.rows.slice(0, rows).map((row, i) => <tr key={i}>{dataset.columns.map(c => <td key={c.name} data-null={row[c.name] === null || undefined}>{format(row[c.name])}</td>)}</tr>)}</tbody>
    </table></div>
    {dataset.rowCount > rows && <p className="pg-more">Showing {rows} of {dataset.rowCount.toLocaleString()} rows. Download for the full table.</p>}
    {dataset.provenance.length > 0 && <figcaption>{dataset.provenance.map((p, i) => <span key={i}>{[p.datasetVersion && <code key="v">{p.datasetVersion}</code>, p.attribution, p.license, p.note].filter(Boolean).map((part, j) => <span key={j}>{j > 0 && " · "}{part}</span>)}</span>)}</figcaption>}
  </figure>;
}

/** Markdown with GFM and KaTeX. Raw HTML is not rendered; images render only as session charts and datasets. */
export function Report({ report, artifacts }: { report: PlaygroundReport; artifacts: Artifacts }) {
  const components: Components = {
    img: ({ src, alt }) => {
      const [kind, name] = String(src ?? "").split(/:(.*)/s);
      if (kind === "chart" && name) {
        const chart = artifacts.charts[name];
        return chart ? <VegaChart chart={chart} datasets={artifacts.datasets} /> : <span className="pg-missing">Chart “{alt || name}” is not available.</span>;
      }
      if (kind === "dataset" && name) {
        const dataset = artifacts.datasets[name];
        return dataset ? <DatasetTable dataset={dataset} /> : <span className="pg-missing">Table “{alt || name}” is not available.</span>;
      }
      return null;
    },
    // Figures render as blocks; a paragraph holding only an embed would otherwise wrap a <figure> in <p>.
    p: ({ children, node }) => node?.children.length === 1 && node.children[0]?.type === "element" && node.children[0].tagName === "img"
      ? <>{children}</> : <p>{children}</p>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="pg-table-wrap"><table>{children}</table></div>,
  };
  return <article className="pg-report">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore" }]]} components={components}
      urlTransform={(url, key) => key === "src" ? (/^(chart|dataset):[a-z0-9_-]+$/.test(url) ? url : "") : defaultUrlTransform(url)}>
      {report.markdown}
    </ReactMarkdown>
  </article>;
}
