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
  assert.match(html, /Identity history and cohort coverage are being backfilled/i);
  assert.match(html, /What this index measures/i);
  assert.match(html, /Times shown in UTC/i);
  assert.match(html, /Network pulse/i);
  assert.match(html, /Active payer addresses/i);
  assert.match(html, /Active server identities/i);
  assert.match(html, /Identity intelligence/i);
  assert.match(html, /Submit a service/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
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
  assert.match(page, /Available indexed history/i);
  assert.match(page, /\/api\/ask/i);
  assert.match(layout, /og-v5\.png/i);
  assert.match(layout, /index:\s*false/i);
  assert.match(layout, /follow:\s*false/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});
