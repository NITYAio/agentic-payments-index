#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const DAY_MS = 86_400_000;
const WINDOWS = [1, 7, 30];

function utcStartOfDay(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateFromEnvironment(name, fallback) {
  const raw = process.env[name];
  const value = raw ? new Date(raw) : fallback;
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} must be a valid timestamp.`);
  if (
    value.getUTCHours() !== 0 ||
    value.getUTCMinutes() !== 0 ||
    value.getUTCSeconds() !== 0 ||
    value.getUTCMilliseconds() !== 0
  ) {
    throw new Error(`${name} must use a UTC midnight boundary.`);
  }
  return value;
}

function run(script, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", script, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(
            `${script} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
          ),
        );
      }
    });
  });
}

async function main() {
  if (!process.env.BASE_RPC_URL) {
    throw new Error("BASE_RPC_URL is required to resolve Base timestamps to block numbers.");
  }
  if (!process.env.DIRECT_SOURCE_INGEST_URL || !process.env.DIRECT_SOURCE_INGEST_TOKEN) {
    throw new Error("DIRECT_SOURCE_INGEST_URL and DIRECT_SOURCE_INGEST_TOKEN are required.");
  }

  const to = dateFromEnvironment("REFRESH_TO", utcStartOfDay());
  const from = new Date(to.getTime() - 30 * DAY_MS);
  const outputDir = resolve(
    process.env.X402_REFRESH_OUTPUT_DIR ?? `/tmp/agentic-payments-x402-${to.toISOString().slice(0, 10)}`,
  );
  const sliceConcurrency = process.env.X402_SQD_SLICE_CONCURRENCY ?? "4";
  const manifest = resolve(outputDir, "x402-event-history-manifest.json");

  if (process.env.X402_REFRESH_RESUME !== "1") {
    await rm(outputDir, { recursive: true, force: true });
  }
  await mkdir(outputDir, { recursive: true });

  process.stdout.write(
    `Collecting direct x402 evidence for ${from.toISOString()} → ${to.toISOString()}.\n`,
  );
  await run("scripts/backfill-x402-event-history.mjs", [
    "--source", "sqd",
    "--from", from.toISOString(),
    "--to", to.toISOString(),
    "--slice-hours", "24",
    "--slice-concurrency", sliceConcurrency,
    "--retries", "5",
    "--output-dir", outputDir,
  ]);

  for (const days of WINDOWS) {
    const rangeStart = new Date(to.getTime() - days * DAY_MS);
    const evidence = resolve(outputDir, `x402-${days}d-evidence.json`);
    const receipt = resolve(outputDir, `x402-${days}d-ingestion.json`);
    process.stdout.write(`Building and publishing the exact rolling ${days}d window.\n`);
    await run("scripts/build-x402-event-history.mjs", [
      "--manifest", manifest,
      "--source-provider", "sqd",
      "--from", rangeStart.toISOString(),
      "--to", to.toISOString(),
      "--output", evidence,
    ]);
    await run("scripts/collect-direct-source.mjs", [
      "--evidence", evidence,
      "--output", receipt,
    ]);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      protocol: "x402",
      source: "Base events via SQD Portal",
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      publishedWindows: WINDOWS,
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
