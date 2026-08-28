#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  concentrationSummary,
  createIndexedIdentityAccumulator,
  mergeConcentration,
  verifyIndexedPaymentReceipt,
  X402_INDEX_SOURCE_KEY,
} from "./lib/x402-index-feed.mjs";

const ENDPOINT = "https://www.x402scan.com/api/trpc/public.transfers.list";
const STATS_ENDPOINT = "https://www.x402scan.com/api/trpc/public.stats.overall";
const DEFAULT_OUTPUT = "/private/tmp/api-identity-backfill-x402-index";
const DEFAULT_PAGE_SIZE = 50_000;
const DEFAULT_BATCH_PAGES = 5;
const MAX_SEGMENT_ROWS = 1_000;

function optionsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--force") options.force = true;
    else if (value === "--skip-verification") options.skipVerification = true;
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

function positiveInteger(value, fallback, field) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${field} must be positive.`);
  return parsed;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function retry(label, operation, maximum = 8) {
  let latest;
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      latest = error;
      if (attempt === maximum) break;
      const delay = Math.min(30_000, 1_000 * (2 ** (attempt - 1)));
      process.stderr.write(`${label} failed (${attempt}/${maximum}); retrying in ${delay / 1_000}s.\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw latest;
}

async function trpc(endpoint, input) {
  return retry(endpoint, async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "agentic-payments-index-backfill/1.0" },
      body: JSON.stringify({ json: input }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const payload = await response.json();
    const result = payload?.result?.data?.json;
    if (!result) throw new Error("The indexed feed returned an unexpected response.");
    return result;
  });
}

async function stats() {
  return trpc(STATS_ENDPOINT, { chain: "base", timeframe: 0 });
}

async function page(pageNumber, pageSize) {
  return trpc(ENDPOINT, {
    chain: "base",
    pagination: { page_size: pageSize, page: pageNumber },
    sorting: { id: "block_timestamp", desc: false },
    timeframe: 0,
  });
}

async function rpc(url, method, params) {
  return retry(method, async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}.`);
    const payload = await response.json();
    if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }, 5);
}

async function exists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function segmentsFor(result, batchStart, batchEnd) {
  const totalParts = Math.max(1, Math.ceil(result.activities.length / MAX_SEGMENT_ROWS));
  const queryHash = sha256Hex(JSON.stringify({
    sourceKey: X402_INDEX_SOURCE_KEY,
    batchStart,
    batchEnd,
    indexedRows: result.indexedRows,
  }));
  return Array.from({ length: totalParts }, (_, index) => ({
    sourceKey: X402_INDEX_SOURCE_KEY,
    segmentKey: `x402:index:pages-${String(batchStart).padStart(6, "0")}-${String(batchEnd).padStart(6, "0")}:part-${String(index + 1).padStart(4, "0")}`,
    protocol: "x402",
    network: "base",
    evidenceType: "service_export",
    cursorStart: `page:${batchStart}`,
    cursorEnd: `page:${batchEnd}`,
    queryHash,
    part: index + 1,
    totalParts,
    activities: result.activities.slice(index * MAX_SEGMENT_ROWS, (index + 1) * MAX_SEGMENT_ROWS),
  }));
}

async function loadCompleted(outputDir) {
  const path = resolve(outputDir, "backfill-state.json");
  if (!(await exists(path))) return { nextPage: 0, checkpoints: [] };
  const state = JSON.parse(await readFile(path, "utf8"));
  if (!Number.isSafeInteger(state.nextPage) || !Array.isArray(state.checkpoints)) {
    throw new Error("Existing backfill state is invalid.");
  }
  return state;
}

async function concentrationFromSegments(outputDir, files) {
  const payers = new Map();
  for (const file of files) {
    const segment = JSON.parse(await readFile(resolve(outputDir, file), "utf8"));
    for (const activity of segment.activities ?? []) {
      if (activity.role !== "payer") continue;
      const current = payers.get(activity.identityHash) ?? { transactionCount: 0, volumeUsdMicros: 0n };
      current.transactionCount += activity.transactionCount;
      current.volumeUsdMicros += BigInt(activity.volumeUsdMicros);
      payers.set(activity.identityHash, current);
    }
  }
  return concentrationSummary(payers);
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const outputDir = resolve(options["output-dir"] ?? DEFAULT_OUTPUT);
  const pageSize = positiveInteger(options["page-size"], DEFAULT_PAGE_SIZE, "Page size");
  const batchPages = positiveInteger(options["batch-pages"], DEFAULT_BATCH_PAGES, "Batch pages");
  const concurrency = positiveInteger(options.concurrency, 2, "Concurrency");
  const maximumPages = options["max-pages"]
    ? positiveInteger(options["max-pages"], null, "Maximum pages")
    : null;
  const rpcUrl = options["rpc-url"] ?? process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is required for direct-chain sample verification.");
  await mkdir(outputDir, { recursive: true });

  const initial = await stats();
  const expectedRows = Number(initial.total_transactions);
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1) throw new Error("Indexed total is invalid.");
  const expectedPages = Math.ceil(expectedRows / pageSize);
  let state = options.force ? { nextPage: 0, checkpoints: [] } : await loadCompleted(outputDir);
  let processedRows = state.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.sourceRows, 0);
  if (state.pageSize && state.pageSize !== pageSize) {
    if (processedRows % pageSize !== 0) {
      throw new Error(
        `Cannot resume ${processedRows.toLocaleString()} rows with page size ${pageSize.toLocaleString()}. ` +
        "Choose a page size that divides the completed prefix exactly.",
      );
    }
    const previousPageSize = state.pageSize;
    state = {
      ...state,
      nextPage: processedRows / pageSize,
      expectedPages,
      pageSize,
      pageSizeMigrations: [
        ...(state.pageSizeMigrations ?? []),
        {
          from: previousPageSize,
          to: pageSize,
          processedRows,
          migratedAt: new Date().toISOString(),
        },
      ],
    };
    await writeFile(resolve(outputDir, "backfill-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    process.stderr.write(
      `Adjusted the resume cursor from ${previousPageSize.toLocaleString()}-row pages to ` +
      `${pageSize.toLocaleString()}-row pages at page ${state.nextPage.toLocaleString()}.\n`,
    );
  }
  const targetPages = maximumPages
    ? Math.min(expectedPages, state.nextPage + maximumPages)
    : expectedPages;
  const allFiles = state.checkpoints.flatMap((checkpoint) => checkpoint.segmentFiles ?? []);
  let verifiedSamples = state.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.verifiedSamples, 0);
  let failedSamples = state.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.failedSamples, 0);
  if (options.skipVerification && verifiedSamples < 1) {
    throw new Error("--skip-verification requires at least one previously verified direct-chain sample.");
  }

  process.stderr.write(
    `Backfilling ${expectedRows.toLocaleString()} indexed Base payments across ${expectedPages.toLocaleString()} pages; resuming at page ${state.nextPage.toLocaleString()}.\n`,
  );

  for (let batchStart = state.nextPage; batchStart < targetPages; batchStart += batchPages) {
    const batchEndExclusive = Math.min(targetPages, batchStart + batchPages);
    const pageNumbers = Array.from({ length: batchEndExclusive - batchStart }, (_, index) => batchStart + index);
    const results = [];
    for (let cursor = 0; cursor < pageNumbers.length; cursor += concurrency) {
      const slice = pageNumbers.slice(cursor, cursor + concurrency);
      results.push(...await Promise.all(slice.map((pageNumber) => page(pageNumber, pageSize))));
    }
    const accumulator = createIndexedIdentityAccumulator();
    const batchPayers = new Map();
    const samples = [];
    let sourceRows = 0;
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const result of results) {
      if (!Array.isArray(result.items)) throw new Error("Indexed page is missing items.");
      sourceRows += result.items.length;
      const candidates = [result.items[0], result.items[Math.floor(result.items.length / 2)], result.items.at(-1)]
        .filter(Boolean);
      for (const value of result.items) {
        const payment = accumulator.consume(value);
        if (!payment) continue;
        mergeConcentration(batchPayers, payment);
        firstTimestamp = !firstTimestamp || payment.timestamp < firstTimestamp ? payment.timestamp : firstTimestamp;
        lastTimestamp = !lastTimestamp || payment.timestamp > lastTimestamp ? payment.timestamp : lastTimestamp;
      }
      samples.push(...candidates);
    }
    const sampleRows = options.skipVerification
      ? []
      : [...new Map(samples.map((sample) => [sample.tx_hash, sample])).values()]
        .slice(0, Math.max(3, Math.ceil(results.length / 2)));
    let batchVerified = 0;
    let batchFailed = 0;
    for (const sample of sampleRows) {
      const sampleAccumulator = createIndexedIdentityAccumulator();
      const payment = sampleAccumulator.consume(sample);
      if (!payment) continue;
      const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [payment.transactionHash]);
      const verification = verifyIndexedPaymentReceipt(payment, receipt);
      if (verification.verified) batchVerified += 1;
      else batchFailed += 1;
    }
    if (batchVerified === 0 && batchFailed > 0) {
      throw new Error(`Direct-chain verification failed for every sample in pages ${batchStart}-${batchEndExclusive - 1}.`);
    }
    const result = accumulator.result();
    const segments = segmentsFor(result, batchStart, batchEndExclusive - 1);
    const segmentFiles = [];
    for (const segment of segments) {
      const file = `x402-index-pages-${String(batchStart).padStart(6, "0")}-${String(batchEndExclusive - 1).padStart(6, "0")}-part-${String(segment.part).padStart(4, "0")}.json`;
      await writeFile(resolve(outputDir, file), `${JSON.stringify(segment)}\n`, "utf8");
      segmentFiles.push(file);
    }
    const checkpoint = {
      batchStart,
      batchEnd: batchEndExclusive - 1,
      sourceRows,
      indexedUsdcRows: result.indexedRows,
      excludedNonUsdc: result.excludedNonUsdc,
      activityRows: result.activities.length,
      firstTimestamp,
      lastTimestamp,
      verifiedSamples: batchVerified,
      failedSamples: batchFailed,
      verificationSkipped: options.skipVerification === true,
      segmentFiles,
      batchConcentration: concentrationSummary(batchPayers),
    };
    const checkpointFile = `x402-index-pages-${String(batchStart).padStart(6, "0")}-${String(batchEndExclusive - 1).padStart(6, "0")}-checkpoint.json`;
    await writeFile(resolve(outputDir, checkpointFile), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    allFiles.push(...segmentFiles);
    processedRows += sourceRows;
    verifiedSamples += batchVerified;
    failedSamples += batchFailed;
    state = {
      schemaVersion: 1,
      nextPage: batchEndExclusive,
      expectedPages,
      expectedRows,
      pageSize,
      checkpoints: [...state.checkpoints, { ...checkpoint, checkpointFile }],
    };
    await writeFile(resolve(outputDir, "backfill-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const manifest = {
      schemaVersion: 1,
      privacy: "Contains SHA-256 identity hashes only; raw wallet addresses are never written.",
      protocol: "x402",
      sourceKey: X402_INDEX_SOURCE_KEY,
      rangeStart: state.checkpoints[0]?.firstTimestamp,
      rangeEnd: lastTimestamp,
      indexedSnapshotAsOf: initial.latest_block_timestamp ?? null,
      indexedSnapshotRows: expectedRows,
      processedRows,
      complete: batchEndExclusive >= expectedPages,
      verifiedSamples,
      failedSamples,
      segmentFiles: allFiles,
    };
    await writeFile(resolve(outputDir, "x402-index-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stderr.write(
      `Checkpoint pages ${batchStart.toLocaleString()}–${(batchEndExclusive - 1).toLocaleString()}: ${sourceRows.toLocaleString()} rows, ${result.activities.length.toLocaleString()} identity-month aggregates, ${batchVerified}/${sampleRows.length} chain samples verified.\n`,
    );
  }

  const manifestPath = resolve(outputDir, "x402-index-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const concentration = await concentrationFromSegments(outputDir, manifest.segmentFiles);
  await writeFile(
    resolve(outputDir, "x402-buyer-concentration.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      privacy: "Aggregate concentration only; no wallet addresses or identity hashes are published.",
      sourceKey: X402_INDEX_SOURCE_KEY,
      rangeStart: manifest.rangeStart,
      rangeEnd: manifest.rangeEnd,
      ...concentration,
    }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify({ manifest: manifestPath, concentration, ...manifest }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
