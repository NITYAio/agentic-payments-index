#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const DEFAULT_WINDOWS = [1, 7, 30];
const SUPPORTED_PROTOCOLS = ["mpp", "x402"];

function configuredProtocols() {
  const requested = (process.env.REFRESH_PROTOCOLS ?? SUPPORTED_PROTOCOLS.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = requested.filter((value) => !SUPPORTED_PROTOCOLS.includes(value));
  if (invalid.length > 0) {
    throw new Error(`REFRESH_PROTOCOLS contains unsupported values: ${invalid.join(", ")}.`);
  }
  if (requested.length === 0) throw new Error("REFRESH_PROTOCOLS must include at least one protocol.");
  return [...new Set(requested)];
}

function configuredWindows() {
  const requested = (process.env.REFRESH_WINDOWS ?? DEFAULT_WINDOWS.join(","))
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
  const invalid = requested.filter((value) => !DEFAULT_WINDOWS.includes(value));
  if (invalid.length > 0) {
    throw new Error(`REFRESH_WINDOWS contains unsupported values: ${invalid.join(", ")}.`);
  }
  if (requested.length === 0) throw new Error("REFRESH_WINDOWS must include 1, 7, or 30.");
  return [...new Set(requested)];
}

function exactTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error("REFRESH_TO must be a valid timestamp.");
  date.setMilliseconds(0);
  return date;
}

function safeStamp(value) {
  return value.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function collect(protocol, days, to, dryRun) {
  const from = new Date(to.getTime() - days * DAY_MS);
  const output = resolve(
    tmpdir(),
    `agentic-payments-${protocol}-${days}d-${safeStamp(to)}.json`,
  );
  const args = [
    "--env-file-if-exists=.env.local",
    "scripts/collect-direct-source.mjs",
    "--protocol",
    protocol,
    "--from",
    from.toISOString(),
    "--to",
    to.toISOString(),
    "--output",
    output,
  ];
  if (protocol === "mpp") {
    args.push("--chunk-size", "10000", "--rpc-delay-ms", "100");
  }
  if (protocol === "x402") {
    const source = (
      process.env.X402_SOURCE ?? (process.env.BASE_RPC_URL ? "events" : "cdp")
    ).toLowerCase();
    args.push("--source", source);
    if (["events", "event", "rpc"].includes(source)) {
      args.push(
        "--chunk-size",
        process.env.X402_EVENT_CHUNK_SIZE ?? "10000",
        "--rpc-delay-ms",
        process.env.X402_RPC_DELAY_MS ?? "75",
        "--rpc-concurrency",
        process.env.X402_RPC_CONCURRENCY ?? "3",
        "--block-batch-size",
        process.env.X402_BLOCK_BATCH_SIZE ?? "3",
      );
    }
  }
  if (dryRun) args.push("--no-ingest");
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  if (stdout.trim()) process.stdout.write(stdout);
  const saved = JSON.parse(await readFile(output, "utf8"));
  const evidence = saved.collector ?? saved;
  const summary = evidence.windowSummary;
  if (!summary || summary.rangeStart !== from.toISOString() || summary.rangeEnd !== to.toISOString()) {
    throw new Error(`${protocol} ${days}d returned a mismatched window.`);
  }
  for (const field of ["transactionCount", "volumeUsdMicros", "buyerCount", "sellerCount"]) {
    if (!Number.isFinite(Number(summary[field])) || Number(summary[field]) < 0) {
      throw new Error(`${protocol} ${days}d returned invalid ${field}.`);
    }
  }
  return {
    protocol,
    days,
    rangeStart: summary.rangeStart,
    rangeEnd: summary.rangeEnd,
    transactionCount: summary.transactionCount,
    volumeUsd: summary.volumeUsdMicros / 1_000_000,
    ingested: Boolean(saved.ingestion),
  };
}

async function main() {
  const protocols = configuredProtocols();
  const windows = configuredWindows();
  if (protocols.includes("mpp") && !process.env.TEMPO_RPC_URL) {
    throw new Error("TEMPO_RPC_URL is required when refreshing MPP.");
  }
  const x402Source = (
    process.env.X402_SOURCE ?? (process.env.BASE_RPC_URL ? "events" : "cdp")
  ).toLowerCase();
  if (
    protocols.includes("x402") &&
    ["events", "event", "rpc"].includes(x402Source) &&
    !process.env.BASE_RPC_URL
  ) {
    throw new Error("BASE_RPC_URL is required for event-based x402 refreshes.");
  }
  if (
    protocols.includes("x402") &&
    ["cdp", "sql"].includes(x402Source) &&
    !process.env.CDP_CLIENT_API_KEY
  ) {
    throw new Error("CDP_CLIENT_API_KEY is required for CDP-based x402 refreshes.");
  }
  if (
    protocols.includes("x402") &&
    !["events", "event", "rpc", "cdp", "sql"].includes(x402Source)
  ) {
    throw new Error("X402_SOURCE must be events or cdp.");
  }
  const dryRun = process.env.REFRESH_DRY_RUN === "1";
  if (!dryRun && !process.env.DIRECT_SOURCE_INGEST_URL) {
    throw new Error("DIRECT_SOURCE_INGEST_URL is required unless REFRESH_DRY_RUN=1.");
  }
  if (!dryRun && !process.env.DIRECT_SOURCE_INGEST_TOKEN) {
    throw new Error("DIRECT_SOURCE_INGEST_TOKEN is required unless REFRESH_DRY_RUN=1.");
  }
  const to = exactTimestamp(process.env.REFRESH_TO);
  const results = [];
  for (const days of windows) {
    for (const protocol of protocols) {
      process.stdout.write(`Refreshing ${protocol} ${days}d through ${to.toISOString()}\n`);
      results.push(await collect(protocol, days, to, dryRun));
    }
  }
  process.stdout.write(
    `${JSON.stringify({ dryRun, protocols, windows, to: to.toISOString(), results }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
