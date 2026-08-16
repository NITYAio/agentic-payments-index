#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  aggregateMppIdentityActivity,
  buildTempoLogFilter,
  buildTempoSessionLogFilter,
  buildX402IdentitySql,
  buildX402MultiLegSql,
  createJsonRpcClient,
  normalizeX402IdentityRows,
  parseDateRange,
  sha256Hex,
  splitUtcDateRange,
  x402TerminalIdentityActivities,
} from "./lib/direct-source.mjs";

const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/data/query/run";
const TRANSFER_WITH_MEMO_TOPIC =
  "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
const MAX_SEGMENT_ROWS = 1_000;

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--no-ingest") options.noIngest = true;
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

async function loadRegistry(pathValue) {
  const path = resolve(pathValue ?? "data/x402-base-facilitators.json");
  const registry = JSON.parse(await readFile(path, "utf8"));
  if (
    registry.schemaVersion !== 1 ||
    registry.network !== "base" ||
    registry.asset !== "USDC" ||
    !Array.isArray(registry.addresses)
  ) {
    throw new Error("The x402 facilitator registry is incompatible.");
  }
  return registry;
}

async function cdpSql(sql) {
  const clientApiKey = process.env.CDP_CLIENT_API_KEY;
  if (!clientApiKey) throw new Error("CDP_CLIENT_API_KEY is required for x402 identity collection.");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://${CDP_HOST}${CDP_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, cache: { maxAgeMs: 60_000 } }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (cause) {
      if (attempt === 5) {
        const error = new Error("Coinbase CDP SQL network request failed after retries.", {
          cause,
        });
        error.splitRecommended = true;
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 750 * 2 ** attempt));
      continue;
    }
    if (response.ok) {
      const body = await response.json();
      return Array.isArray(body.result) ? body.result : [];
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 5) {
      const body = await response.text();
      const error = new Error(`Coinbase CDP SQL failed (${response.status}): ${body}`);
      if (
        response.status === 400 &&
        (body.includes("TOO_MANY_ROWS_OR_BYTES") || body.includes("Limit for rows or bytes"))
      ) {
        error.tooManyRows = true;
      }
      if (response.status >= 500) error.splitRecommended = true;
      throw error;
    }
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : 750 * 2 ** attempt;
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
  }
  throw new Error("Coinbase CDP SQL exhausted its retry budget.");
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

async function collectX402(from, to, options) {
  const registry = await loadRegistry(options.registry);
  const addresses = [...new Set(registry.addresses.map((entry) => entry.address.toLowerCase()))];
  const tokenAddress = registry.tokenAddress.toLowerCase();
  const activities = [];

  async function collectRole(role, rangeStart, rangeEnd) {
    const sql = buildX402IdentitySql({
      addresses,
      tokenAddress,
      from: rangeStart,
      to: rangeEnd,
      role,
    });
    try {
      return normalizeX402IdentityRows(await cdpSql(sql), role);
    } catch (error) {
      if (
        (!error.tooManyRows && !error.splitRecommended) ||
        rangeEnd.getTime() - rangeStart.getTime() <= 3_600_000
      ) throw error;
      const middle = new Date(
        Math.floor((rangeStart.getTime() + rangeEnd.getTime()) / 2 / 3_600_000) * 3_600_000,
      );
      if (middle <= rangeStart || middle >= rangeEnd) throw error;
      const [left, right] = await Promise.all([
        collectRole(role, rangeStart, middle),
        collectRole(role, middle, rangeEnd),
      ]);
      return mergeActivities([...left, ...right]);
    }
  }

  const roleActivity = await Promise.all(
    ["payer", "payee"].map((role) => collectRole(role, from, to)),
  );
  for (const rows of roleActivity) {
    for (const row of rows) activities.push(row);
  }

  async function collectMultiLegs(rangeStart, rangeEnd) {
    try {
      return await cdpSql(buildX402MultiLegSql({
        addresses,
        tokenAddress,
        from: rangeStart,
        to: rangeEnd,
      }));
    } catch (error) {
      const duration = rangeEnd.getTime() - rangeStart.getTime();
      if ((!error.tooManyRows && !error.splitRecommended) || duration <= 3_600_000) throw error;
      const middle = new Date(
        Math.floor((rangeStart.getTime() + duration / 2) / 3_600_000) * 3_600_000,
      );
      if (middle <= rangeStart || middle >= rangeEnd) throw error;
      const [left, right] = await Promise.all([
        collectMultiLegs(rangeStart, middle),
        collectMultiLegs(middle, rangeEnd),
      ]);
      return [...left, ...right];
    }
  }
  activities.push(...x402TerminalIdentityActivities(await collectMultiLegs(from, to)));
  return {
    sourceKey: "identity:x402:base-usdc:cdp-sql:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      from,
      to,
      addresses,
      tokenAddress,
      transferClassification: "ordered-receive-forward-terminal-v1",
    })),
    activities: mergeActivities(activities),
  };
}

async function tempoBlockRange(rpc, from, to) {
  const latest = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const cache = new Map();
  async function block(number) {
    if (!cache.has(number)) {
      const result = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
      if (!result) throw new Error(`Tempo block ${number} was not found.`);
      cache.set(number, {
        number,
        timestamp: new Date(Number.parseInt(result.timestamp, 16) * 1_000),
      });
    }
    return cache.get(number);
  }
  async function firstAtOrAfter(target) {
    let low = 0;
    let high = latest + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (middle > latest || (await block(middle)).timestamp >= target) high = middle;
      else low = middle + 1;
    }
    return low;
  }
  return {
    fromBlock: await firstAtOrAfter(from),
    toBlockExclusive: await firstAtOrAfter(to),
  };
}

async function tempoLogs(rpc, filterForRange, fromBlock, toBlockExclusive, preferredChunk) {
  const logs = [];
  async function range(start, end) {
    if (end < start) return;
    try {
      logs.push(...await rpc("eth_getLogs", [filterForRange(start, end + 1)]));
    } catch (error) {
      if (error.nonSplittable || start === end) throw error;
      const middle = Math.floor((start + end) / 2);
      await range(start, middle);
      await range(middle + 1, end);
    }
  }
  for (let start = fromBlock; start < toBlockExclusive; start += preferredChunk) {
    await range(start, Math.min(toBlockExclusive - 1, start + preferredChunk - 1));
  }
  return logs;
}

function mergeActivities(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = [row.role, row.identityScheme, row.identityHash, row.activityMonth, row.evidenceLevel].join("|");
    const current = merged.get(key);
    if (current) {
      current.transactionCount += row.transactionCount;
      current.volumeUsdMicros += row.volumeUsdMicros;
      if (row.firstSeenAt < current.firstSeenAt) current.firstSeenAt = row.firstSeenAt;
      if (row.lastSeenAt > current.lastSeenAt) current.lastSeenAt = row.lastSeenAt;
    } else merged.set(key, { ...row });
  }
  return [...merged.values()].sort((left, right) =>
    [left.activityMonth, left.role, left.identityScheme, left.identityHash]
      .join("|")
      .localeCompare([right.activityMonth, right.role, right.identityScheme, right.identityHash].join("|")),
  );
}

async function collectMpp(from, to, options) {
  const rpcUrl = options["rpc-url"] ?? process.env.TEMPO_RPC_URL ?? DEFAULT_TEMPO_RPC;
  const rpc = createJsonRpcClient({
    url: rpcUrl,
    minDelayMs: Number.parseInt(options["rpc-delay-ms"] ?? "150", 10),
  });
  const preferredChunk = Number.parseInt(options["chunk-size"] ?? "25000", 10);
  const dailyActivity = [];
  const queryRanges = [];
  for (const window of splitUtcDateRange(from, to)) {
    const blocks = await tempoBlockRange(rpc, window.from, window.to);
    const [chargeLogs, sessionLogs] = await Promise.all([
      tempoLogs(
        rpc,
        (start, end) => buildTempoLogFilter({
          fromBlock: start,
          toBlockExclusive: end,
          eventTopic: TRANSFER_WITH_MEMO_TOPIC,
        }),
        blocks.fromBlock,
        blocks.toBlockExclusive,
        preferredChunk,
      ),
      tempoLogs(
        rpc,
        (start, end) => buildTempoSessionLogFilter({ fromBlock: start, toBlockExclusive: end }),
        blocks.fromBlock,
        blocks.toBlockExclusive,
        preferredChunk,
      ),
    ]);
    const dayTimestamp = new Date(window.from.toISOString().slice(0, 10) + "T00:00:00.000Z");
    const blockTimestamps = new Map(
      [...chargeLogs, ...sessionLogs].map((log) => [Number.parseInt(log.blockNumber, 16), dayTimestamp]),
    );
    dailyActivity.push(...aggregateMppIdentityActivity({ chargeLogs, sessionLogs, blockTimestamps }));
    queryRanges.push([blocks.fromBlock, blocks.toBlockExclusive]);
  }
  return {
    sourceKey: "identity:mpp:tempo-attribution-rpc",
    protocol: "mpp",
    network: "tempo",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      provider: new URL(rpcUrl).host,
      from,
      to,
      queryRanges,
      topic: TRANSFER_WITH_MEMO_TOPIC,
    })),
    activities: mergeActivities(dailyActivity),
  };
}

function makeSegments(result, from, to) {
  const segments = [];
  const totalParts = Math.ceil(result.activities.length / MAX_SEGMENT_ROWS);
  for (let index = 0; index < result.activities.length; index += MAX_SEGMENT_ROWS) {
    const part = Math.floor(index / MAX_SEGMENT_ROWS) + 1;
    segments.push({
      sourceKey: result.sourceKey,
      segmentKey: `${result.protocol}:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}:${String(part).padStart(4, "0")}`,
      protocol: result.protocol,
      network: result.network,
      evidenceType: result.evidenceType,
      cursorStart: from.toISOString(),
      cursorEnd: to.toISOString(),
      queryHash: result.queryHash,
      part,
      totalParts,
      activities: result.activities.slice(index, index + MAX_SEGMENT_ROWS),
    });
  }
  return segments;
}

async function ingestSegment(segment, options) {
  if (options.noIngest) return { status: "not_requested" };
  const ingestUrl = options["ingest-url"] ?? process.env.IDENTITY_INGEST_URL;
  if (!ingestUrl) return { status: "not_configured" };
  const token = process.env.IDENTITY_INGEST_TOKEN;
  if (!token) throw new Error("IDENTITY_INGEST_TOKEN is required when an ingest URL is used.");
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(segment),
  });
  if (!response.ok) throw new Error(`Identity ingestion failed (${response.status}): ${await response.text()}`);
  return await response.json();
}

async function writeSegments(segments, outputDir, label) {
  await mkdir(outputDir, { recursive: true });
  const files = [];
  for (const segment of segments) {
    const file = resolve(outputDir, `${label}-part-${String(segment.part).padStart(4, "0")}.json`);
    await writeFile(file, `${JSON.stringify(segment, null, 2)}\n`, "utf8");
    files.push(file);
  }
  return files;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.manifest) {
    const manifest = JSON.parse(await readFile(resolve(options.manifest), "utf8"));
    const results = [];
    for (const file of manifest.segmentFiles) {
      const segment = JSON.parse(await readFile(resolve(dirname(resolve(options.manifest)), file), "utf8"));
      results.push(await ingestSegment(segment, options));
    }
    process.stdout.write(`${JSON.stringify({ manifest: resolve(options.manifest), ingestion: results }, null, 2)}\n`);
    return;
  }
  if (options.protocol !== "mpp" && options.protocol !== "x402") {
    throw new Error("--protocol must be mpp or x402.");
  }
  const { from, to } = parseDateRange(options.from, options.to);
  const outputDir = resolve(options["output-dir"] ?? "data/identity-backfills");
  const allFiles = [];
  const summaries = [];
  for (const range of calendarMonthRanges(from, to)) {
    const result = options.protocol === "x402"
      ? await collectX402(range.from, range.to, options)
      : await collectMpp(range.from, range.to, options);
    const segments = makeSegments(result, range.from, range.to);
    const label = `${options.protocol}-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
    const files = await writeSegments(segments, outputDir, label);
    const ingestion = [];
    for (const segment of segments) ingestion.push(await ingestSegment(segment, options));
    allFiles.push(...files);
    summaries.push({ month: range.month, activities: result.activities.length, segments: segments.length, ingestion });
  }
  const manifestPath = resolve(
    outputDir,
    `${options.protocol}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}-manifest.json`,
  );
  const manifest = {
    schemaVersion: 1,
    privacy: "Contains SHA-256 identity hashes only; raw identity keys are never written.",
    protocol: options.protocol,
    rangeStart: from.toISOString(),
    rangeEnd: to.toISOString(),
    segmentFiles: allFiles.map((file) => basename(file)),
    summaries,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
