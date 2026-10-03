import { RequestForm } from "./request-form";
export default function Page() {
  return <main>
    <header><a className="brand" href="/">◈ verdant<span>AI</span></a><span className="badge">Developer preview</span></header>
    <section className="intro"><p className="eyebrow">CLIMATE DATA, READY TO USE</p>
      <h1>Your agent has a question.<br /><em>Give it better data.</em></h1>
      <p className="description">Specify the place, period and format. Verdant is being built to retrieve, normalize and deliver climate data with its evidence intact.</p>
    </section>
    <section className="workspace"><div className="context"><p className="eyebrow">01 / DEFINE YOUR REQUEST</p>
      <h2>One clear contract.<br />Every source accounted for.</h2>
      <p>Start with daily maximum temperature around Mildura, Australia. Validate the request before acquisition and payment are connected.</p>
      <dl><dt>Source</dt><dd>SILO</dd><dt>Units</dt><dd>Degrees Celsius</dd><dt>Resolution</dt><dd>Native grid · daily</dd><dt>Missing data</dt><dd>Preserved</dd></dl>
    </div><RequestForm /></section>
    <footer>Request → Retrieve → Normalize → Validate → Deliver<span>Foundation build · no purchases or acquisition yet</span></footer>
  </main>;
}
