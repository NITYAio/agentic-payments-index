import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import "./register-cloudflare.mjs";

const projectRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders The Agentic Payments Index experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /The Agentic Payments Index/i);
  assert.match(html, /machine economy/i);
  assert.match(html, /All protocols/i);
  assert.match(html, /MPP \+ x402/i);
  assert.match(html, /Ask the Index/i);
  assert.match(html, /Ask about metrics/i);
  assert.match(html, /Public beta/i);
  assert.match(html, /MPP history is available.*x402 identity history is still being backfilled/is);
  assert.match(html, /MPP on Tempo.*x402 on Base/i);
  assert.match(html, /Payment value/i);
  assert.match(html, /Trust Barometer/i);
  assert.match(html, /Named services/i);
  assert.doesNotMatch(html, /Not combined/i);
  assert.match(html, /What this index measures/i);
  assert.match(html, /Updated through/i);
  assert.match(html, /Network pulse/i);
  assert.match(html, /Active payer addresses/i);
  assert.match(html, /Active recipient addresses/i);
  assert.match(html, /Identity intelligence/i);
  assert.match(html, /Submit a service/i);
  assert.match(html, /Average daily transactions/i);
  assert.doesNotMatch(html, /Transaction velocity/i);
  assert.doesNotMatch(html, /Relative activity/i);
  assert.doesNotMatch(html, /Signal \/ Average payment size/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("server-renders the named About and protocol coverage pages", async () => {
  const [aboutResponse, coverageResponse] = await Promise.all([
    render("/about"),
    render("/coverage"),
  ]);
  assert.equal(aboutResponse.status, 200);
  assert.equal(coverageResponse.status, 200);
  const [about, coverage] = await Promise.all([
    aboutResponse.text(),
    coverageResponse.text(),
  ]);
  assert.match(about, /Nitya Sharma/i);
  assert.match(about, /founder of Simpl/i);
  assert.match(about, /Submit data or a correction/i);
  assert.match(coverage, /What the market discloses/i);
  assert.match(coverage, /Virtuals ACP/i);
  assert.match(coverage, /Why there is no.*Other.*total/i);
  assert.match(coverage, /Trust Barometer methodology/i);
});

test("server-renders the private direct-source verification surface", async () => {
  const response = await render("/direct-preview");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Direct-source cutover review/i);
  assert.match(html, /Primary evidence/i);
  assert.match(html, /Payment value is counted once at the payer.*original amount/i);
  assert.match(html, /recipient value and gross transfer movement remain available for audit/i);
  assert.match(html, /Loading verified evidence/i);
});

test("ships product metadata and removes starter dependencies", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    access(new URL("../public/og-v5.png", import.meta.url)),
  ]);

  assert.match(page, /Compare MPP and x402/i);
  assert.match(page, /protocolForQuestion/i);
  assert.match(page, /Verified calculation/i);
  assert.match(page, /Machine-readable view/i);
  assert.match(page, /Indexed service records/i);
  assert.match(page, /Payer addresses/i);
  assert.match(page, /History/i);
  assert.match(page, /\/api\/ask/i);
  assert.match(page, /Copy live link/i);
  assert.match(page, /Download card/i);
  assert.match(layout, /og-v5\.png/i);
  assert.match(layout, /index:\s*false/i);
  assert.match(layout, /follow:\s*false/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});
