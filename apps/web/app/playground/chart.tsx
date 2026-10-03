"use client";
import { useEffect, useRef, useState } from "react";
import type { PlaygroundChart, PlaygroundDataset } from "@verdant/contracts/playground";

// Validated categorical order (adjacent-pair CVD ΔE ≥ 8, normal-vision ≥ 15 on light surfaces); fixed order, never cycled.
const categorical = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const ink = "#072a1a", ink2 = "#3d5c48", line = "rgba(7, 42, 26, .12)";
const font = "Inter Tight, ui-sans-serif, system-ui, sans-serif";
export const chartTheme = {
  background: "transparent", font,
  view: { stroke: null },
  title: { font, fontSize: 15, fontWeight: 600, color: ink, anchor: "start", offset: 12, subtitleColor: ink2 },
  axis: { labelFont: font, titleFont: font, labelFontSize: 11.5, titleFontSize: 12, titleFontWeight: 500, labelColor: ink2, titleColor: ink2,
    domainColor: line, tickColor: line, gridColor: line, gridDash: [2, 3], labelPadding: 6, titlePadding: 10 },
  axisX: { grid: false }, axisY: { domain: false, ticks: false },
  legend: { labelFont: font, titleFont: font, labelColor: ink2, titleColor: ink2, labelFontSize: 11.5, titleFontSize: 12, symbolType: "circle", orient: "top" },
  range: { category: categorical, ordinal: { scheme: "greens" }, ramp: { scheme: "greens" }, heatmap: { scheme: "greens" },
    diverging: ["#2a78d6", "#9cbde8", "#e7e9e4", "#f2ac8f", "#eb6834"] },
  line: { strokeWidth: 2, strokeCap: "round", strokeJoin: "round" },
  point: { size: 64, filled: true, strokeWidth: 2, stroke: "#fbfef6" },
  bar: { cornerRadiusEnd: 4, stroke: "#fbfef6", strokeWidth: 2 },
  area: { opacity: .85, line: { strokeWidth: 2 } },
  rule: { color: ink2, strokeDash: [4, 4] },
  text: { font, color: ink, fontSize: 11.5 },
  mark: { tooltip: { content: "encoding" } },
};

/** A Vega-Lite chart whose named data sources are the session's saved datasets. Nothing is fetched over the network. */
export function VegaChart({ chart, datasets }: { chart: PlaygroundChart; datasets: Record<string, PlaygroundDataset> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const missing = chart.datasets.filter(name => !datasets[name]);
  const data = chart.datasets.map(name => datasets[name]);
  useEffect(() => {
    if (!ref.current || missing.length) return;
    let disposed = false, finalize: (() => void) | undefined;
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", width: "container", autosize: { type: "fit-x", contains: "padding" },
      ...chart.spec, datasets: Object.fromEntries(chart.datasets.map(name => [name, datasets[name]!.rows])) };
    import("vega-embed").then(async ({ default: embed }) => {
      if (disposed || !ref.current) return;
      const { loader } = await import("vega");
      // A loader that refuses every request: specs may only read the inline session datasets.
      const offline = loader();
      offline.load = async () => { throw new Error("Charts cannot load external resources."); };
      const result = await embed(ref.current, spec as never, { actions: false, renderer: "svg", config: chartTheme as never, loader: offline, tooltip: { theme: "custom" } });
      if (disposed) result.finalize(); else finalize = result.finalize;
    }).catch(e => { if (!disposed) setError((e as Error).message.slice(0, 200)); });
    return () => { disposed = true; finalize?.(); };
    // Re-render when the chart or any of its datasets is replaced.
  }, [chart, ...data]); // eslint-disable-line react-hooks/exhaustive-deps
  return <figure className="pg-chart">
    {missing.length ? <p className="pg-missing">Chart “{chart.title}” needs {missing.join(", ")}, which has not been saved.</p>
      : error ? <p className="pg-missing">Chart “{chart.title}” could not be drawn: {error}</p> : <div ref={ref} className="pg-chart-canvas" />}
    {chart.caption && <figcaption>{chart.caption}</figcaption>}
  </figure>;
}
