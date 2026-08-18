#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  aggregateMppPayments,
  aggregateX402TerminalPayments,
  buildTempoLogFilter,
  buildTempoSessionLogFilter,
  buildX402DailySql,
  buildX402MultiLegSql,
  COLLECTOR_VERSION,
  createJsonRpcClient,
  fillDailyMetricRange,
  parseDateRange,
  sha256Hex,
  splitUtcDateRange,
  summarizeTrustPayments,
} from "./lib/direct-source.mjs";

const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/data/query/run";
// keccak256("TransferWithMemo(address,address,uint256,bytes32)") from the
// official Tempo TIP-20 event ABI.
const TRANSFER_WITH_MEMO_TOPIC =
  "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") options.dryRun = true;
    else if (value === "--no-ingest") options.noIngest = true;
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
  if (!clientApiKey) throw new Error("CDP_CLIENT_API_KEY is required for x402 collection.");
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
      const timedOut = cause?.name === "TimeoutError";
      if ((timedOut && attempt >= 1) || attempt === 5) {
        const error = new Error("Coinbase CDP SQL network request failed after retries.", {
          cause,
        });
        error.splitRecommended = timedOut;
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
    if (!retryable || attempt === 5 || (response.status >= 500 && attempt >= 1)) {
      const body = await response.text();
      const error = new Error(`Coinbase CDP SQL failed (${response.status}): ${body}`);
      if (
        response.status === 400 &&
        (body.includes("TOO_MANY_ROWS_OR_BYTES") || body.includes("Limit for rows or bytes"))
      ) {
        error.tooManyRows = true;
      }
      if (response.status >= 500) {
        error.splitRecommended = true;
      }
      throw error;
    }
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : 750 * 2 ** attempt;
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
  }
  throw new Error("Coinbase CDP SQL exhausted its retry budget.");
}

async function collectX402({ from, to, options }) {
  const registry = await loadRegistry(options.registry);
  const addresses = [...new Set(registry.addresses.map((entry) => entry.address.toLowerCase()))];
  const tokenAddress = registry.tokenAddress.toLowerCase();
  const dailySql = buildX402DailySql({ addresses, tokenAddress, from, to });
  const multiLegSql = buildX402MultiLegSql({ addresses, tokenAddress, from, to });
  const queryHash = sha256Hex(JSON.stringify({
    dailySql,
    multiLegSql,
    transferClassification: "ordered-receive-forward-terminal-v1",
  }));
  if (options.dryRun) {
    return {
      dryRun: true,
      protocol: "x402",
      queryHash,
      registryAddresses: addresses.length,
      registryFacilitators: Object.keys(registry.facilitators).length,
      dailySql,
      multiLegSql,
    };
  }

  async function collectWithSplit(builder, rangeStart, rangeEnd, depth = 0) {
    try {
      return await cdpSql(builder({ addresses, tokenAddress, from: rangeStart, to: rangeEnd }));
    } catch (error) {
      const duration = rangeEnd.getTime() - rangeStart.getTime();
      if (
        (!error.tooManyRows && !error.splitRecommended) ||
        duration <= 15 * 60 * 1_000 ||
        depth >= 12
      ) {
        throw error;
      }
      const middle = new Date(
        Math.floor((rangeStart.getTime() + duration / 2) / 60_000) * 60_000,
      );
      if (middle <= rangeStart || middle >= rangeEnd) throw error;
      const left = await collectWithSplit(builder, rangeStart, middle, depth + 1);
      const right = await collectWithSplit(builder, middle, rangeEnd, depth + 1);
      return [...left, ...right];
    }
  }

  async function collectRangesWithConcurrency(ranges, concurrency, label, collectRange) {
    const results = new Array(ranges.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < ranges.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await collectRange(ranges[index]);
        process.stderr.write(
          `Collected x402 ${label} ${index + 1}/${ranges.length}: ` +
            `${ranges[index].from.toISOString()}–${ranges[index].to.toISOString()}\n`,
        );
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ranges.length) }, () => worker()),
    );
    return results.flat();
  }

  const sqlConcurrency = Number.parseInt(options["sql-concurrency"] ?? "3", 10);
  if (!Number.isSafeInteger(sqlConcurrency) || sqlConcurrency < 1 || sqlConcurrency > 6) {
    throw new Error("--sql-concurrency must be an integer between 1 and 6.");
  }
  const dailyRanges = splitUtcDateRange(from, to);
  process.stderr.write("Collecting x402 single-leg aggregates…\n");
  const singleRows = await collectRangesWithConcurrency(
    dailyRanges,
    sqlConcurrency,
    "single-leg aggregates",
    (range) => collectWithSplit(buildX402DailySql, range.from, range.to),
  );
  const multiLegRows = await collectRangesWithConcurrency(
    dailyRanges,
    sqlConcurrency,
    "transfer routing",
    (range) => collectWithSplit(buildX402MultiLegSql, range.from, range.to),
  );
  const { metrics: populated, windowSummary } = aggregateX402TerminalPayments({
    singleRows,
    multiLegRows,
    from,
    to,
  });
  const template = populated[0] ?? {
    measurementUnit: "onchain_settlement",
    evidenceLevel: "deterministic",
    isAdjusted: false,
    limitation:
      "Base USDC settlements submitted by the versioned public facilitator registry. Each receive-then-forward proxy chain counts once at the payer's original amount and is attributed to the terminal recipient. Testing, self-payment, unresolved ownership, non-Base, and non-USDC activity remain unadjusted.",
  };
  return {
    sourceKey: "direct:x402:base-usdc:cdp-sql",
    protocol: "x402",
    network: "base",
    queryHash,
    inputRowCount:
      singleRows.reduce((total, row) => total + Number(row.transfer_count ?? 0), 0) +
      multiLegRows.length,
    metrics: fillDailyMetricRange(from, to, populated, template),
    windowSummary,
    coverage: {
      measurementUnit: "onchain_settlement",
      sourceType: "chain_sql",
      sourceUrl: "https://docs.cdp.coinbase.com/data/sql-api/welcome",
      coverageStart: from.toISOString(),
      coverageEnd: to.toISOString(),
      status: recentStatus(to),
      limitation: template.limitation,
      methodologyUrl: "https://agenticpaymentsindex.org/methodology",
    },
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
    block,
  };
}

async function tempoLogs(rpc, filterForRange, fromBlock, toBlockExclusive, preferredChunk = 25_000) {
  const logs = [];
  async function range(start, end) {
    if (end < start) return;
    try {
      const result = await rpc("eth_getLogs", [
        filterForRange(start, end + 1),
      ]);
      logs.push(...result);
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

async function collectMpp({ from, to, options }) {
  const rpcUrl = options["rpc-url"] ?? process.env.TEMPO_RPC_URL ?? DEFAULT_TEMPO_RPC;
  const rpc = createJsonRpcClient({
    url: rpcUrl,
    minDelayMs: Number.parseInt(options["rpc-delay-ms"] ?? "150", 10),
  });
  const dailyRanges = [];
  for (const window of splitUtcDateRange(from, to)) {
    const blocks = await tempoBlockRange(rpc, window.from, window.to);
    dailyRanges.push({
      activityDate: window.from.toISOString().slice(0, 10),
      fromBlock: blocks.fromBlock,
      toBlockExclusive: blocks.toBlockExclusive,
    });
  }
  const fromBlock = dailyRanges[0].fromBlock;
  const toBlockExclusive = dailyRanges.at(-1).toBlockExclusive;
  const queryDefinition = JSON.stringify({
    rpcProviderHost: new URL(rpcUrl).host,
    chainId: 4217,
    fromBlock,
    toBlockExclusive,
    dailyRanges,
    topic: TRANSFER_WITH_MEMO_TOPIC,
    sessionEvent: "TIP-1034 Settled(bytes32,address,address,uint96,uint96,uint96)",
    mppMemoPrefix: "0xef1ed71201",
    tokens: [
      "0x20c0000000000000000000000000000000000000",
      "0x20c000000000000000000000b9537d11c60e8b50",
    ],
  });
  if (options.dryRun) {
    return {
      dryRun: true,
      protocol: "mpp",
      queryHash: sha256Hex(queryDefinition),
      fromBlock,
      toBlockExclusive,
      dailyRanges,
      eventTopic: TRANSFER_WITH_MEMO_TOPIC,
      sessionSettlement: "TIP-1034 Settled deltaPaid",
    };
  }
  const metrics = [];
  const windowBuyers = new Set();
  const windowSellers = new Set();
  let acceptedLogCount = 0;
  let acceptedChargeLogCount = 0;
  let acceptedSessionLogCount = 0;
  let windowChargeVolumeUsdMicros = 0;
  let windowSessionVolumeUsdMicros = 0;
  const windowTrustAmounts = [];
  let windowExcludedZeroCount = 0;
  let windowExcludedSelfCount = 0;
  for (const range of dailyRanges) {
    const preferredChunk = Number.parseInt(options["chunk-size"] ?? "25000", 10);
    const [dailyLogs, sessionLogs] = await Promise.all([
      tempoLogs(
        rpc,
        (start, end) =>
          buildTempoLogFilter({
            fromBlock: start,
            toBlockExclusive: end,
            eventTopic: TRANSFER_WITH_MEMO_TOPIC,
          }),
        range.fromBlock,
        range.toBlockExclusive,
        preferredChunk,
      ),
      tempoLogs(
        rpc,
        (start, end) =>
          buildTempoSessionLogFilter({ fromBlock: start, toBlockExclusive: end }),
        range.fromBlock,
        range.toBlockExclusive,
        preferredChunk,
      ),
    ]);
    const activityTimestamp = new Date(`${range.activityDate}T00:00:00.000Z`);
    const blockTimestamps = new Map();
    for (const log of [...dailyLogs, ...sessionLogs]) {
      const blockNumber = Number.parseInt(log.blockNumber, 16);
      blockTimestamps.set(blockNumber, activityTimestamp);
    }
    const dailyAggregate = aggregateMppPayments({
      chargeLogs: dailyLogs,
      sessionLogs,
      blockTimestamps,
    });
    acceptedLogCount += dailyAggregate.acceptedLogCount;
    acceptedChargeLogCount += dailyAggregate.acceptedChargeLogCount;
    acceptedSessionLogCount += dailyAggregate.acceptedSessionLogCount;
    windowTrustAmounts.push(...dailyAggregate.windowTrust.amounts);
    windowExcludedZeroCount += dailyAggregate.windowTrust.excludedZeroCount;
    windowExcludedSelfCount += dailyAggregate.windowTrust.excludedSelfCount;
    for (const identity of dailyAggregate.windowSets.buyers) windowBuyers.add(identity);
    for (const identity of dailyAggregate.windowSets.sellers) windowSellers.add(identity);
    windowChargeVolumeUsdMicros += dailyAggregate.metrics.reduce(
      (total, metric) => total + metric.chargeVolumeUsdMicros,
      0,
    );
    windowSessionVolumeUsdMicros += dailyAggregate.metrics.reduce(
      (total, metric) => total + metric.sessionVolumeUsdMicros,
      0,
    );
    metrics.push(...dailyAggregate.metrics);
  }
  const template = metrics[0] ?? {
    measurementUnit: "protocol_payment",
    evidenceLevel: "deterministic",
    isAdjusted: false,
    limitation:
      "Counts current-version MPP charges in pathUSD and USDC.e plus TIP-1034 Settled session events; session value uses deltaPaid. " +
      "Active server identities are memo fingerprints observed on charges. NANOUSD, invalid or older memos, and off-chain vouchers not yet settled are excluded.",
  };
  const windowTrust = summarizeTrustPayments(
    windowTrustAmounts,
    windowExcludedZeroCount,
    windowExcludedSelfCount,
  );
  return {
    sourceKey: "direct:mpp:tempo-attribution-rpc",
    protocol: "mpp",
    network: "tempo",
    queryHash: sha256Hex(queryDefinition),
    inputRowCount: acceptedLogCount,
    inputBreakdown: {
      chargeLogs: acceptedChargeLogCount,
      sessionSettlements: acceptedSessionLogCount,
    },
    metrics: fillDailyMetricRange(from, to, metrics, template),
    windowSummary: {
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      measurementUnit: "protocol_payment",
      transactionCount: metrics.reduce((total, metric) => total + metric.transactionCount, 0),
      chargeCount: metrics.reduce((total, metric) => total + metric.chargeCount, 0),
      sessionCount: metrics.reduce((total, metric) => total + metric.sessionCount, 0),
      settlementCount: metrics.reduce((total, metric) => total + metric.settlementCount, 0),
      volumeUsdMicros: metrics.reduce((total, metric) => total + metric.volumeUsdMicros, 0),
      chargeVolumeUsdMicros: windowChargeVolumeUsdMicros,
      sessionVolumeUsdMicros: windowSessionVolumeUsdMicros,
      buyerCount: windowBuyers.size,
      sellerCount: windowSellers.size,
      ...windowTrust,
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation: template.limitation,
    },
    coverage: {
      measurementUnit: "protocol_payment",
      sourceType: "chain_rpc",
      sourceUrl: DEFAULT_TEMPO_RPC,
      coverageStart: from.toISOString(),
      coverageEnd: to.toISOString(),
      status: recentStatus(to),
      limitation: template.limitation,
      methodologyUrl: "https://agenticpaymentsindex.org/methodology",
    },
  };
}

function recentStatus(to) {
  return Date.now() - to.getTime() < 36 * 60 * 60 * 1_000 ? "active" : "backfilling";
}

async function ingest(result, from, to, options) {
  if (options.noIngest) return result;
  const ingestUrl = options["ingest-url"] ?? process.env.DIRECT_SOURCE_INGEST_URL;
  const token = process.env.DIRECT_SOURCE_INGEST_TOKEN;
  if (!ingestUrl) return result;
  if (!token) throw new Error("DIRECT_SOURCE_INGEST_TOKEN is required when an ingest URL is used.");
  const runKey = `${result.protocol}:${from.toISOString()}:${to.toISOString()}:${result.queryHash.slice(0, 16)}`;
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sourceKey: result.sourceKey,
      runKey,
      protocol: result.protocol,
      network: result.network,
      collectorVersion: COLLECTOR_VERSION,
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      queryHash: result.queryHash,
      inputRowCount: result.inputRowCount,
      metrics: result.metrics,
      windowSummary: result.windowSummary,
      coverage: result.coverage,
    }),
  });
  if (!response.ok) throw new Error(`Ingestion failed (${response.status}): ${await response.text()}`);
  return { collector: result, ingestion: await response.json() };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  let result;
  let from;
  let to;
  let protocol;
  if (options.evidence) {
    result = JSON.parse(await readFile(resolve(options.evidence), "utf8"));
    protocol = result.protocol;
    if (protocol !== "mpp" && protocol !== "x402") {
      throw new Error("The evidence file protocol must be mpp or x402.");
    }
    from = new Date(result.windowSummary?.rangeStart);
    to = new Date(result.windowSummary?.rangeEnd);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
      throw new Error("The evidence file must contain a valid windowSummary range.");
    }
  } else {
    protocol = options.protocol;
    if (protocol !== "mpp" && protocol !== "x402") {
      throw new Error("--protocol must be mpp or x402.");
    }
    ({ from, to } = parseDateRange(options.from, options.to));
    result =
      protocol === "x402"
        ? await collectX402({ from, to, options })
        : await collectMpp({ from, to, options });
  }
  const output = result.dryRun ? result : await ingest(result, from, to, options);
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.output) {
    const outputPath = resolve(options.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
    process.stdout.write(
      `${JSON.stringify({ outputPath, protocol, rangeStart: from.toISOString(), rangeEnd: to.toISOString() }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
