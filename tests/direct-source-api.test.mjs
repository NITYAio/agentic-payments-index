import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { Miniflare } from "miniflare";

import "./register-cloudflare.mjs";
import { env } from "./cloudflare-workers-stub.mjs";

const TOKEN = "test-direct-source-token";

async function localDatabase() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: `direct-source-api-${process.pid}-${Date.now()}` },
  });
  const database = await runtime.getD1Database("DB");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const statements = (await readFile(new URL(migration, migrationDirectory), "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => database.prepare(statement));
    await database.batch(statements);
  }
  return { runtime, database };
}

async function evidence(protocol) {
  return JSON.parse(
    await readFile(
      new URL(
        `../data/backfills/${protocol}-2026-07-10_2026-08-09.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

test("direct-source migration, ingestion, idempotency, and 30-day read work end to end", async () => {
  const { runtime, database } = await localDatabase();
  env.DB = database;
  env.DIRECT_SOURCE_INGEST_TOKEN = TOKEN;
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const bindings = {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: database,
      DIRECT_SOURCE_INGEST_TOKEN: TOKEN,
    };
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    };

    for (const protocol of ["x402", "mpp"]) {
      const payload = await evidence(protocol);
      const requestBody = {
        ...payload,
        collectorVersion: "0.1.0-test",
        runKey: `${protocol}:2026-07-10:2026-08-09:test`,
        rangeStart: payload.windowSummary.rangeStart,
        rangeEnd: payload.windowSummary.rangeEnd,
      };
      const request = () =>
        new Request("http://localhost/api/internal/direct-source-ingest", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
      const inserted = await worker.fetch(request(), bindings, context);
      assert.equal(inserted.status, 201);
      assert.deepEqual(await inserted.json(), {
        runId: await runId(payload.sourceKey, requestBody.runKey),
        status: "complete",
        metricRows: 30,
        windowMetricRows: 1,
        coverage: "active",
      });

      const replay = await worker.fetch(request(), bindings, context);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).idempotentReplay, true);
    }

    const response = await worker.fetch(
      new Request("http://localhost/api/direct-source?protocol=all&days=30"),
      bindings,
      context,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, true);
    assert.equal(body.metrics.length, 60);
    assert.equal(body.windowMetrics.length, 2);
    const x402 = body.windowMetrics.find((metric) => metric.protocol === "x402");
    const mpp = body.windowMetrics.find((metric) => metric.protocol === "mpp");
    assert.equal(x402.buyerCount, 15_742);
    assert.equal(x402.sellerCount, 73_534);
    assert.equal(mpp.buyerCount, 43_831);
    assert.equal(mpp.sellerCount, 15_618);
    assert.match(body.disclosure, /daily identity counts.*never summed/i);
  } finally {
    delete env.DB;
    delete env.DIRECT_SOURCE_INGEST_TOKEN;
    await runtime.dispose();
  }
});

async function runId(sourceKey, runKey) {
  const bytes = new TextEncoder().encode(`${sourceKey}|${runKey}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
