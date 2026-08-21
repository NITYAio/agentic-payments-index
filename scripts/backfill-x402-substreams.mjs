#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { sha256Hex } from "./lib/direct-source.mjs";
import {
  blockRangeForDates,
  createBudgetSafeRpcClient,
} from "./lib/x402-base-rpc.mjs";
import {
  createSubstreamsIdentityAccumulator,
  settlementsFromJsonLine,
  X402_SUBSTREAMS_SOURCE_KEY,
} from "./lib/x402-substreams.mjs";

const MAX_SEGMENT_ROWS = 1_000;
const DEFAULT_BINARY = "/private/tmp/substreams-cli/substreams";
const DEFAULT_PACKAGE = "x402-base-pulse@v3.3.0";
const DEFAULT_ENDPOINT = "base-mainnet.streamingfast.io:443";

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--force") options.force = true;
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

function dateRange(fromValue, toValue) {
  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    throw new Error("--from and --to must define a valid UTC date range.");
  }
  return { from, to };
}

function resolvedBaseRpcUrl(options) {
  const explicit = options["rpc-url"] ?? process.env.BASE_RPC_URL;
  if (explicit) return explicit;
  const tempoUrl = process.env.TEMPO_RPC_URL;
  if (!tempoUrl) {
    throw new Error(
      "BASE_RPC_URL is required (or TEMPO_RPC_URL must use a dRPC Tempo endpoint).",
    );
  }
  const derived = new URL(tempoUrl);
  if (!derived.pathname.includes("/tempo-mainnet/")) {
    throw new Error("BASE_RPC_URL is required because TEMPO_RPC_URL cannot be safely converted.");
  }
  derived.pathname = derived.pathname.replace("/tempo-mainnet/", "/base-mainnet/");
  return derived.toString();
}

function calendarMonthRanges(from, to) {
  const ranges = [];
  let cursor = new Date(from);
  while (cursor < to) {
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const end = nextMonth < to ? nextMonth : new Date(to);
    ranges.push({ from: new Date(cursor), to: end, month: cursor.toISOString().slice(0, 7) });
    cursor = end;
  }
  return ranges;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function makeSegments(result, from, to, queryHash) {
  const totalParts = Math.max(1, Math.ceil(result.activities.length / MAX_SEGMENT_ROWS));
  return Array.from({ length: totalParts }, (_, index) => ({
    sourceKey: X402_SUBSTREAMS_SOURCE_KEY,
    segmentKey: `x402:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}:${String(index + 1).padStart(4, "0")}`,
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    cursorStart: from.toISOString(),
    cursorEnd: to.toISOString(),
    queryHash,
    part: index + 1,
    totalParts,
    activities: result.activities.slice(index * MAX_SEGMENT_ROWS, (index + 1) * MAX_SEGMENT_ROWS),
  }));
}

async function collectRange({ binary, packageName, endpoint, fromBlock, toBlockExclusive, from, to }) {
  const accumulator = createSubstreamsIdentityAccumulator({ from, to });
  const args = [
    "run",
    packageName,
    "map_x402_settlements",
    "-e",
    endpoint,
    "-s",
    String(fromBlock),
    "-t",
    String(toBlockExclusive),
    "-o",
    "jsonl",
    "--production-mode",
    "--final-blocks-only",
    "--limit-processed-blocks",
    "0",
    "--max-retries",
    "8",
  ];
  const child = spawn(binary, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const value = String(chunk);
    stderr = `${stderr}${value}`.slice(-12_000);
    process.stderr.write(value);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let parsedLines = 0;
  for await (const line of lines) {
    let envelope;
    try {
      envelope = settlementsFromJsonLine(line);
    } catch (error) {
      throw new Error(`Substreams returned invalid JSONL: ${error.message}`);
    }
    if (!envelope) continue;
    accumulator.consume(envelope);
    parsedLines += 1;
    if (parsedLines % 10_000 === 0) {
      process.stderr.write(`Parsed ${parsedLines.toLocaleString()} x402 block outputs.\n`);
    }
  }
  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    const authHint = /authorization token|api key|unauthenticated/i.test(stderr)
      ? " Set SUBSTREAMS_API_TOKEN in .env.local using a free The Graph Market key."
      : "";
    throw new Error(`Substreams exited with code ${exitCode}.${authHint}`);
  }
  return { ...accumulator.result(), parsedLines };
}

async function writeMonth({ outputDir, label, range, blocks, result, packageName, endpoint }) {
  const queryHash = sha256Hex(JSON.stringify({
    sourceKey: X402_SUBSTREAMS_SOURCE_KEY,
    packageName,
    endpoint,
    from: range.from,
    to: range.to,
    fromBlock: blocks.fromBlock,
    toBlockExclusive: blocks.toBlockExclusive,
  }));
  const segments = makeSegments(result, range.from, range.to, queryHash);
  const files = [];
  for (const segment of segments) {
    const fileName = `${label}-part-${String(segment.part).padStart(4, "0")}.json`;
    await writeFile(resolve(outputDir, fileName), `${JSON.stringify(segment, null, 2)}\n`, "utf8");
    files.push(fileName);
  }
  const checkpoint = {
    schemaVersion: 1,
    sourceKey: X402_SUBSTREAMS_SOURCE_KEY,
    month: range.month,
    rangeStart: range.from.toISOString(),
    rangeEnd: range.to.toISOString(),
    fromBlock: blocks.fromBlock,
    toBlockExclusive: blocks.toBlockExclusive,
    settlements: result.settlementCount,
    activities: result.activities.length,
    parsedLines: result.parsedLines,
    skippedInvalid: result.skippedInvalid,
    skippedOutsideRange: result.skippedOutsideRange,
    segmentFiles: files,
  };
  await writeFile(
    resolve(outputDir, `${label}-checkpoint.json`),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf8",
  );
  return checkpoint;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const { from, to } = dateRange(options.from, options.to);
  const rpcUrl = resolvedBaseRpcUrl(options);
  const binary = resolve(options["substreams-bin"] ?? process.env.SUBSTREAMS_BIN ?? DEFAULT_BINARY);
  if (!(await exists(binary))) throw new Error(`Substreams CLI was not found at ${binary}.`);
  const packageName = options.package ?? DEFAULT_PACKAGE;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const outputDir = resolve(options["output-dir"] ?? "/private/tmp/api-identity-backfill-x402");
  await mkdir(outputDir, { recursive: true });
  const rpc = createBudgetSafeRpcClient({ url: rpcUrl, minDelayMs: 100 });
  const summaries = [];
  const allFiles = [];

  for (const range of calendarMonthRanges(from, to)) {
    const label = `x402-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
    const checkpointPath = resolve(outputDir, `${label}-checkpoint.json`);
    if (!options.force && await exists(checkpointPath)) {
      const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
      if ((await Promise.all(checkpoint.segmentFiles.map((file) => exists(resolve(outputDir, file))))).every(Boolean)) {
        process.stderr.write(`Reusing completed x402 checkpoint for ${range.month}.\n`);
        summaries.push(checkpoint);
        allFiles.push(...checkpoint.segmentFiles);
        continue;
      }
    }
    const blocks = await blockRangeForDates(rpc, range.from, range.to);
    process.stderr.write(
      `Backfilling x402 ${range.month}: blocks ${blocks.fromBlock.toLocaleString()}–${(blocks.toBlockExclusive - 1).toLocaleString()}.\n`,
    );
    const result = await collectRange({
      binary,
      packageName,
      endpoint,
      fromBlock: blocks.fromBlock,
      toBlockExclusive: blocks.toBlockExclusive,
      from: range.from,
      to: range.to,
    });
    const checkpoint = await writeMonth({
      outputDir,
      label,
      range,
      blocks,
      result,
      packageName,
      endpoint,
    });
    summaries.push(checkpoint);
    allFiles.push(...checkpoint.segmentFiles);
  }

  const manifestName = `x402-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}-manifest.json`;
  const manifest = {
    schemaVersion: 1,
    sourceKey: X402_SUBSTREAMS_SOURCE_KEY,
    protocol: "x402",
    rangeStart: from.toISOString(),
    rangeEnd: to.toISOString(),
    package: packageName,
    endpoint,
    privacy: "Contains SHA-256 identity hashes only; raw identity keys are never written.",
    segmentFiles: allFiles,
    summaries,
  };
  const manifestPath = resolve(outputDir, manifestName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, summaries }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
