/* eslint-disable @next/next/no-html-link-for-pages */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — The Agentic Payments Index",
  description: "Who built The Agentic Payments Index, why it exists, and how to contribute data or corrections.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="editorialPage">
      <nav className="editorialNav">
        <a href="/" className="brand">
          <span className="brandMark" aria-hidden="true"><i /><i /></span>
          <span>THE AGENTIC PAYMENTS INDEX</span>
        </a>
        <div><a href="/coverage">Coverage</a><a href="/">Open the index ↗</a></div>
      </nav>

      <header className="editorialHero">
        <span className="sectionNumber">About</span>
        <h1>Independent infrastructure for understanding agentic payments.</h1>
        <p>
          The Index exists to make a fast-moving market legible without turning
          protocol activity into a larger claim than the evidence supports.
        </p>
      </header>

      <section className="editorialGrid">
        <article>
          <span>01 / Founder</span>
          <h2>Nityanand Sharma</h2>
          <p>
            Nityanand is the founder of Simpl. He built The Agentic Payments
            Index as an independent side project for operators, investors,
            researchers, protocol teams, and journalists.
          </p>
        </article>
        <article>
          <span>02 / Why</span>
          <h2>One neutral evidence layer</h2>
          <p>
            Protocol dashboards answer useful but different questions. This
            project makes their definitions, time windows, sources, and limits
            comparable—and makes disagreements visible instead of smoothing them over.
          </p>
        </article>
        <article>
          <span>03 / Independence</span>
          <h2>Open methods, named ownership</h2>
          <p>
            The project is not affiliated with MPP, x402, or their indexes.
            Protocol teams can contribute evidence, but no team receives a
            preferred methodology or ranking.
          </p>
        </article>
      </section>

      <section className="participatePanel">
        <div>
          <span className="sectionNumber">Participate</span>
          <h2>Corrections should create conversations.</h2>
          <p>
            Submit a source, reproduce a discrepancy, propose a methodology, or
            discuss a missing protocol in public. Security reports remain private.
          </p>
        </div>
        <div className="participateLinks">
          <a href="https://github.com/NITYAio/agentic-payments-index/issues/new/choose" target="_blank" rel="noreferrer">Submit data or a correction ↗</a>
          <a href="https://github.com/NITYAio/agentic-payments-index/discussions" target="_blank" rel="noreferrer">Discuss methodology ↗</a>
          <a href="https://github.com/NITYAio/agentic-payments-index" target="_blank" rel="noreferrer">View the source and change history ↗</a>
        </div>
      </section>

      <footer className="editorialFooter">
        <span>Built openly by Nityanand Sharma</span>
        <a href="/">Back to the live index →</a>
      </footer>
    </main>
  );
}
