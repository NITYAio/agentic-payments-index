import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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

test("server-renders the finished Blockscope experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Blockscope — Stablecoin Payments Intelligence/i);
  assert.match(html, /Agent payments/i);
  assert.match(html, /All protocols/i);
  assert.match(html, /MPP \+ x402/i);
  assert.match(html, /Ask Blockscope/i);
  assert.match(html, /Ready to query the network/i);
  assert.match(html, /Press Ask to calculate/i);
  assert.match(html, /Network pulse/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("ships product metadata and removes starter dependencies", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    access(new URL("../public/og-v2.png", import.meta.url)),
  ]);

  assert.match(page, /Compare MPP and x402/i);
  assert.match(page, /protocolForQuestion/i);
  assert.match(page, /Verified calculation/i);
  assert.match(layout, /og-v2\.png/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});
