import { Fragment, type CSSProperties } from "react";
import { exampleRequest } from "@verdant/contracts";
import { Field } from "./field";
import { SkyToggle } from "./sky";
import { SoundToggle } from "./sound";
import { RequestForm } from "./request-form";

const vars = (values: Record<string, string | number>) => values as CSSProperties;

const manifesto = "Climate data arrives in every shape: grids, stations, spreadsheets, archives. Units drift. Resolutions clash. Calendars disagree. Your agent shouldn't have to untangle any of it. Verdant retrieves, normalizes and delivers exactly what was asked for, with its _evidence _intact.".split(" ");
const fragments = ["°F", "kelvin", "EPSG:3577", ".nc", "−9999", "0.05°", "NaN → 0", ".tif", "mm/day", "UTC+10", ".xlsx", "monthly?"];
const stages = ["Request", "Retrieve", "Normalize", "Validate", "Deliver"];
const tape = "SILO · NOAA nClimGrid · NOAA CPC · daily maximum and minimum temperature · precipitation · EPSG:4326 · native grid · missing values preserved · CSV · JSON · ";
const steps = [
  { title: "Request", text: "Name the variable, place, period, units and format. Meaning stays separate from serialization, so “temperature as CSV” is never ambiguous." },
  { title: "Retrieve", text: "Published data returns instantly. Anything not yet published is fetched from the source on request by an agent with narrow, audited tools, paid per acquisition through MPP." },
  { title: "Normalize", text: "Units, calendars, spatial support and missing values are reconciled and documented, never quietly relabeled or filled." },
  { title: "Validate", text: "Deterministic checks reconcile every cell with the source bytes and confirm dimensions, units and coverage before anything is published." },
  { title: "Deliver", text: "Receive JSON values with provenance directly, or request CSV in the response. Pin the dataset version for reproducible queries." },
];
const facets = [
  ["Sources", "SILO · NOAA nClimGrid · NOAA CPC"], ["Variables", "Max & min temperature · precipitation"], ["Units", "°C · mm"], ["Resolution", "Native grid · daily"],
  ["Coordinates", "WGS84 · EPSG:4326"], ["Data class", "Interpolated observation"], ["Missing data", "Preserved"], ["Formats", "CSV · JSON"],
];
const nevers = ["Missing values → zero", "Coarse pixel → fine measurement", "Undocumented interpolation"];
const clouds = [{ y: "6%", s: 1.25, t: "150s", d: "-40s", x: "6vw" }, { y: "19%", s: 0.8, t: "115s", d: "-95s", x: "62vw" }, { y: "2%", s: 0.95, t: "180s", d: "-150s", x: "84vw" }, { y: "30%", s: 0.55, t: "100s", d: "-12s", x: "38vw" }];

const docs = "https://docs.verdant-ai.com";
const guides = [
  { title: "Quickstart", text: "Discover coverage and get real values directly in an HTTP response.", href: `${docs}/quickstart`, tag: "5 min" },
  { title: "Connect an agent", text: "Add the Verdant MCP server to any client that supports remote MCP.", href: `${docs}/agents/mcp`, tag: "MCP", code: "https://api.verdant-ai.com/mcp" },
  { title: "The data contract", text: "Units, spatial support, missingness and the guarantees behind every response.", href: `${docs}/concepts/data-contract`, tag: "Concepts" },
  { title: "API reference", text: "Every endpoint, generated from the same runtime schemas the API validates with.", href: `${docs}/api-reference/discovery/discover-capabilities`, tag: "OpenAPI 3.1" },
];

function seeded(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

// Two layers of stars twinkle out of phase; they only show once the sky reaches dusk.
function Stars() {
  const random = seeded(23);
  return [0, 1].map(layer => <i key={layer} className="stars" style={{ boxShadow: Array.from({ length: 45 }, () =>
    `${(random() * 100).toFixed(1)}vw ${(random() * 52).toFixed(1)}svh 0 ${random() < 0.15 ? 1 : 0}px rgba(255,255,240,${(0.35 + random() * 0.6).toFixed(2)})`).join() }} />);
}

function Words({ text, from = 0 }: { text: string; from?: number }) {
  return text.split(" ").map((word, i) => <Fragment key={i}>{i > 0 && " "}<span className="h-word"><span style={vars({ "--i": from + i })}>{word}</span></span></Fragment>);
}

function Mark() {
  return <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <path className="mark-stem" d="M16 30V14" />
    <path className="mark-leaf" d="M16 19C16 12 11.5 7.5 4 7.5 4 15 8.5 19 16 19Z" />
    <path className="mark-leaf mark-leaf-r" d="M16 15.5C16 9 20 4.5 27.5 4.5 27.5 11 23.5 15.5 16 15.5Z" />
  </svg>;
}

function Sprig() {
  return <svg className="sprig" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 20C14 14 16 4 20 0c4 4 6 14 0 20Zm0 0c6-6 16-4 20 0-4 4-14 6-20 0Zm0 0c6 6 4 16 0 20-4-4-6-14 0-20Zm0 0c-6 6-16 4-20 0 4-4 14-6 20 0Z" /></svg>;
}

function Arrow() {
  return <svg className="arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" /></svg>;
}

// Deterministic grass silhouette for soft section edges; three groups sway out of phase.
function GrassEdge({ className }: { className: string }) {
  const random = seeded(11);
  const groups: string[] = ["", "", ""];
  for (let i = 0; i < 220; i++) {
    const x = Math.round(i * 9.1 + random() * 5), h = Math.round(16 + random() * 46), lean = Math.round((random() - 0.5) * 18), w = 2 + Math.round(random() * 2);
    groups[i % 3] += `M${x - w} 64Q${x + Math.round(lean * 0.3)} ${64 - Math.round(h * 0.6)} ${x + lean} ${64 - h}Q${x + Math.round(lean * 0.3) + 1} ${64 - Math.round(h * 0.6)} ${x + w} 64Z`;
  }
  return <svg className={`grass-edge ${className}`} viewBox="0 0 2000 64" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    {groups.map((d, i) => <path key={i} d={d} />)}<rect y="62" width="2000" height="2" />
  </svg>;
}

// Out-of-focus blades close to the lens frame the meadow from the lower corners.
function Foreground() {
  const random = seeded(5);
  return (["left", "right"] as const).map(side => {
    const inward = side === "left" ? 1 : -1;
    let d = "";
    for (let i = 0; i < 9; i++) {
      const x = Math.round((side === "left" ? -20 : 180) + random() * 300), h = Math.round(170 + random() * 240);
      const lean = Math.round((random() * 0.9 - 0.25) * 150 * inward), w = Math.round(10 + random() * 16), bow = Math.round(lean * 0.2);
      d += `M${x - w} 430Q${x + bow} ${430 - Math.round(h * 0.55)} ${x + lean} ${430 - h}Q${x + bow + Math.round(w * 0.3)} ${430 - Math.round(h * 0.55)} ${x + w} 430Z`;
    }
    return <svg key={side} className={`foreground ${side}`} viewBox="0 0 460 430" preserveAspectRatio={side === "left" ? "xMinYMax slice" : "xMaxYMax slice"} aria-hidden="true"><path d={d} /></svg>;
  });
}

function RegionMap() {
  return <svg className="region" viewBox="0 0 300 180" aria-hidden="true">
    {Array.from({ length: 60 }, (_, i) => {
      const x = i % 10, y = Math.floor(i / 10);
      return <rect key={i} x={x * 30 + 1} y={y * 30 + 1} width="28" height="28" rx="4" style={vars({ "--d": `${(x + y) * 90}ms`, "--o": 0.12 + ((x * 7 + y * 3) % 5) * 0.07 })} />;
    })}
    <path className="region-box" d="M92 62h116v62H92Z" />
    <circle className="region-ping" cx="146" cy="88" r="6" /><circle className="region-pin" cx="146" cy="88" r="4" />
  </svg>;
}

export default function Page() {
  return <>
    <nav className="nav" aria-label="Primary">
      <a className="brand" href="#top"><Mark />verdant<span> AI</span></a>
      <div className="nav-links"><a href="#how">How it works</a><a href="#evidence">Evidence</a><a href="/api/v1/openapi.json">API contract</a><a href={docs}>Docs <span aria-hidden="true">↗</span></a></div>
      <a className="nav-cta" href="#request">Query data <Arrow /></a>
    </nav>

    <main>
      <section className="hero" id="top">
        <div className="washes" aria-hidden="true"><i className="wash dawn" /><i className="wash golden" /><i className="wash dusk" /><Stars /><i className="moon" /><i className="rays" /></div>
        <div className="sun" aria-hidden="true" />
        <div className="hero-copy">
          <p className="chip"><span className="pulse" />Live · Climate data, ready to use</p>
          <h1><span className="line"><Words text="Your agent has a question." /></span>
            <span className="line serif"><Words text="Give it" from={5} />{" "}<span className="underlined"><Words text="better data." from={7} /><svg className="swash" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true"><path d="M4 18C80 6 170 4 250 9s110 6 146 1" /></svg></span></span></h1>
          <div className="hero-row">
            <p className="lede">Specify the place, period and format. Verdant retrieves, normalizes and delivers climate data with its evidence intact.</p>
            <div className="actions"><a className="button" href="#request">Query real data <Arrow /></a><a className="button ghost" href={docs}>Read the docs <span aria-hidden="true">↗</span></a></div>
          </div>
        </div>
        <div className="sky" aria-hidden="true">
          {clouds.map((cloud, i) => <span key={i} className="cloud" style={vars({ "--y": cloud.y, "--s": cloud.s, "--t": cloud.t, "--d": cloud.d, "--x": cloud.x })} />)}
          <span className="flock">{[0, 1, 2, 3, 4].map(i => <svg key={i} className="bird" viewBox="0 0 20 8" style={vars({ "--i": i, "--x": `${i * 16}px`, "--y": `${Math.abs(i - 2) * 7}px` })}><path d="M1 6Q5 1 10 5Q15 1 19 6" /></svg>)}</span>
        </div>
        <div className="ground" aria-hidden="true" />
        <Field />
        <Foreground />
        <div className="hero-foot"><span className="scroll-cue"><i />Scroll</span><span className="hint">Touch the meadow</span><span className="foot-end"><span className="coords">Mildura, AU · 34.42°S 142.35°E</span><SkyToggle /><SoundToggle /></span></div>
      </section>

      <section className="manifesto" aria-labelledby="problem">
        <div className="manifesto-stage">
          <div className="fragments" aria-hidden="true">
            {fragments.map((text, i) => <span key={text} style={vars({ "--i": i, "--x": `${4 + (i * 37) % 86}%`, "--y": `${6 + (i * 53) % 82}%`, "--r": `${(i * 7) % 13 - 6}deg` })}>{text}</span>)}
          </div>
          <div className="fireflies" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => <i key={i} style={vars({ "--x": `${(i * 41) % 97}%`, "--y": `${(i * 29) % 91}%`, "--dx": `${(i % 3 - 1) * 50 + 20}px`, "--t": `${7 + (i % 5) * 1.7}s`, "--b": `${1.6 + (i % 4) * 0.8}s` })} />)}
          </div>
          <p className="eyebrow" id="problem"><b>01</b>The problem</p>
          <p className="manifesto-text">{manifesto.map((word, i) => {
            const em = word.startsWith("_");
            return <span key={i} className={em ? "w em" : "w"} style={vars({ "--i": i, "--n": manifesto.length })}>{em ? word.slice(1) : word} </span>;
          })}</p>
        </div>
      </section>

      <section className="marquee" aria-label="Request, retrieve, normalize, validate, deliver">
        <GrassEdge className="edge-verdant" />
        <div className="drift" aria-hidden="true"><div className="track">
          {[0, 1].map(copy => stages.map((stage, i) => <span key={`${copy}${stage}`} className={i % 2 ? "serif" : undefined}>{stage}<Sprig /></span>))}
        </div></div>
        <div className="tape" aria-hidden="true"><div className="track reverse"><span>{tape.repeat(3)}</span><span>{tape.repeat(3)}</span></div></div>
      </section>

      <section className="how" id="how">
        <div className="section-head">
          <div><p className="eyebrow"><b>02</b>How it works</p><h2>From question <em>to clean data.</em></h2></div>
          <p>Agents describe what they need. Verdant handles retrieval, reconciliation and checks, then hands back the exact representation requested, with nothing silently changed.</p>
        </div>
        <ol className="steps">
          {steps.map((step, i) => <li className="step" key={step.title}>
            <span className="step-n">0{i + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            <span className="status live"><i />Live</span>
          </li>)}
        </ol>
      </section>

      <section className="evidence" id="evidence">
        <div className="evidence-frame">
          <p className="eyebrow"><b>03</b>Provenance</p>
          <h2 className="giant"><span>Evidence</span> <em>intact.</em></h2>
          <div className="evidence-body">
            <p>Every delivery carries the meaning of its numbers: where they came from, what they measure and what was done to them. Your agent can cite it and check it.</p>
            <ul className="nevers">{nevers.map((never, i) => <li key={never} style={vars({ "--i": i })}>Never <s>{never}</s></li>)}</ul>
          </div>
          <p className="facets-label">Supported requests</p>
          <dl className="facets">{facets.map(([label, value], i) => <div key={label} style={vars({ "--i": i })}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </div>
      </section>

      <section className="request" id="request">
        <div className="section-head">
          <div><p className="eyebrow"><b>04</b>Try the contract</p><h2>One clear contract. <em>Every source accounted for.</em></h2></div>
        </div>
        <div className="workspace">
          <div className="context">
            <RegionMap />
            <p>Query daily maximum temperature around Mildura, Australia. Published dates return instantly with their source and version; Australia, the US and global land can be requested for any covered date.</p>
            <dl><dt>Source</dt><dd>SILO</dd><dt>Units</dt><dd>Degrees Celsius</dd><dt>Resolution</dt><dd>Native grid · daily</dd><dt>Missing data</dt><dd>Preserved</dd></dl>
          </div>
          <RequestForm exampleRequest={exampleRequest} />
        </div>
      </section>

      <section className="build" id="docs">
        <div className="section-head">
          <div><p className="eyebrow"><b>05</b>Build with Verdant</p><h2>Read the docs. <em>Ship the query.</em></h2></div>
          <p>Reading published data is free and needs no API key. New data is acquired on request and paid per acquisition with MPP. Start over HTTP, or hand your agent the MCP server.</p>
        </div>
        <ul className="guides">
          {guides.map((guide, i) => <li key={guide.title} style={vars({ "--i": i })}><a href={guide.href}>
            <span className="guide-tag">{guide.tag}</span>
            {guide.code && <code>{guide.code}</code>}
            <h3>{guide.title}</h3>
            <p>{guide.text}</p>
            <span className="guide-go" aria-hidden="true">↗</span>
          </a></li>)}
        </ul>
      </section>
    </main>

    <footer className="site-footer">
      <GrassEdge className="edge-soil" />
      <div className="footer-row">
        <p>{stages.join(" → ")}</p>
        <p>Published data free · new acquisitions paid per request via MPP</p>
        <nav className="footer-links" aria-label="Footer"><a href={docs}>Docs</a><a href={`${docs}/llms.txt`}>llms.txt</a><a href="/api/v1/openapi.json">OpenAPI</a><a href="#top">Back to top ↑</a></nav>
      </div>
      <p className="wordmark" aria-hidden="true">{[..."verdant"].map((letter, i) => <span key={i} style={vars({ "--i": i })}>{letter}</span>)}</p>
    </footer>
  </>;
}
