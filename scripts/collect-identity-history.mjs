#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { loadIdentityManifest } from "./lib/identity-manifest.mjs";

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
import {
  blockRangeForDates,
  collectX402BaseRpcChunk,
  createBudgetSafeRpcClient,
} from "./lib/x402-base-rpc.mjs";
import { collectX402BaseEventRange } from "./lib/x402-base-events.mjs";
import {
  blockscoutBlockForTime,
  blockscoutTransactionReceipt,
  blockscoutTransactionsForAddress,
  collectX402BlockscoutTransactions,
  createBudgetSafeBlockscoutClient,
} from "./lib/x402-base-blockscout.mjs";
import {
  collectX402BaseSqdRange,
  DEFAULT_BASE_SQD_PORTAL,
} from "./lib/x402-base-sqd.mjs";

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
    else if (value === "--single-range") options.singleRange = true;
    else if (value === "--quiet") options.quiet = true;
    else if (value === "--prefer-tempo-derived") options.preferTempoDerived = true;
    else if (value === "--prefer-tempo-derived-logs") options.preferTempoDerivedLogs = true;
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

function tempoDerivedBaseRpcUrl() {
  const tempoUrl = process.env.TEMPO_RPC_URL;
  if (!tempoUrl) {
    throw new Error(
      "TEMPO_RPC_URL is required to derive the dRPC Base endpoint.",
    );
  }
  const derived = new URL(tempoUrl);
  if (!derived.pathname.includes("/tempo-mainnet/")) {
    throw new Error("BASE_RPC_URL is required because the configured Tempo URL cannot be safely converted.");
  }
  derived.pathname = derived.pathname.replace("/tempo-mainnet/", "/base-mainnet/");
  return derived.toString();
}

function resolvedBaseRpcUrl(options) {
  const explicit = options.preferTempoDerived
    ? null
    : options["rpc-url"] ?? process.env.BASE_RPC_URL;
  return explicit ?? tempoDerivedBaseRpcUrl();
}

async function collectX402Rpc(from, to, options) {
  const registry = await loadRegistry(options.registry);
  const rpcUrl = resolvedBaseRpcUrl(options);
  const concurrency = Number.parseInt(options["rpc-concurrency"] ?? "2", 10);
  const preferredChunk = Number.parseInt(options["trace-chunk-size"] ?? "20", 10);
  const delayMs = Number.parseInt(options["rpc-delay-ms"] ?? "125", 10);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("--rpc-concurrency must be an integer between 1 and 12.");
  }
  if (!Number.isSafeInteger(preferredChunk) || preferredChunk < 1 || preferredChunk > 10_000) {
    throw new Error("--trace-chunk-size must be an integer between 1 and 10000.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("--rpc-delay-ms must be an integer between 0 and 10000.");
  }
  const clients = Array.from({ length: concurrency }, () =>
    createBudgetSafeRpcClient({ url: rpcUrl, minDelayMs: delayMs }),
  );
  const dateRanges = [];
  for (const window of splitUtcDateRange(from, to)) {
    const blocks = await blockRangeForDates(clients[0], window.from, window.to);
    const facilitatorAddresses = registry.addresses
      .filter((entry) => new Date(`${entry.firstSeen}T00:00:00.000Z`) < window.to)
      .map((entry) => entry.address.toLowerCase());
    dateRanges.push({
      activityTimestamp: window.from.toISOString(),
      fromBlock: blocks.fromBlock,
      toBlockExclusive: blocks.toBlockExclusive,
      facilitatorAddresses,
    });
  }
  const chunks = dateRanges.flatMap((range) => {
    const values = [];
    for (let start = range.fromBlock; start < range.toBlockExclusive; start += preferredChunk) {
      values.push({
        ...range,
        fromBlock: start,
        toBlockExclusive: Math.min(range.toBlockExclusive, start + preferredChunk),
      });
    }
    return values;
  });
  const activities = [];
  let nextIndex = 0;
  let traceCount = 0;
  let transactionCount = 0;
  let directTransactionCount = 0;
  let receiptFallbackCount = 0;
  let transferCount = 0;
  const startedAt = Date.now();
  async function worker(workerIndex) {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const chunk = chunks[index];
      const result = await collectX402BaseRpcChunk({
        rpc: clients[workerIndex],
        fromBlock: chunk.fromBlock,
        toBlockExclusive: chunk.toBlockExclusive,
        facilitatorAddresses: chunk.facilitatorAddresses,
        timestamp: chunk.activityTimestamp,
        verifyDirectReceipts: index < 10 ? 1 : 0,
      });
      activities.push(...result.activities);
      traceCount += result.traceCount;
      transactionCount += result.transactionCount;
      directTransactionCount += result.directTransactionCount;
      receiptFallbackCount += result.receiptFallbackCount;
      transferCount += result.transferCount;
      if ((index + 1) % 25 === 0 || index + 1 === chunks.length) {
        const elapsedMinutes = Math.max((Date.now() - startedAt) / 60_000, 1 / 60);
        process.stderr.write(
          `Collected x402 Base RPC chunks ${index + 1}/${chunks.length} ` +
            `(${(index + 1) / elapsedMinutes < 10 ? "" : "~"}${Math.round((index + 1) / elapsedMinutes)}/min)\n`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  return {
    sourceKey: "identity:x402:base-usdc:rpc-trace:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      provider: new URL(rpcUrl).host,
      from,
      to,
      chunks: chunks.map((chunk) => [chunk.fromBlock, chunk.toBlockExclusive]),
      facilitatorAddresses: registry.addresses.map((entry) => entry.address.toLowerCase()),
      transferClassification: "ordered-receive-forward-terminal-v1",
      calldataSelector: "0xe3ee160e",
      receiptFallback: true,
    })),
    collection: {
      chunks: chunks.length,
      traceCount,
      transactionCount,
      directTransactionCount,
      receiptFallbackCount,
      transferCount,
    },
    activities: mergeActivities(activities),
  };
}

async function collectX402Events(from, to, options) {
  const registry = await loadRegistry(options.registry);
  const rpcUrl = resolvedBaseRpcUrl(options);
  const logRpcUrl = options.preferTempoDerivedLogs
    ? tempoDerivedBaseRpcUrl()
    : options["log-rpc-url"] ?? rpcUrl;
  const preferredChunk = Number.parseInt(options["event-chunk-size"] ?? "10000", 10);
  const blockBatchSize = Number.parseInt(options["block-batch-size"] ?? "3", 10);
  const receiptMode = options["receipt-mode"] ?? "block";
  const delayMs = Number.parseInt(options["rpc-delay-ms"] ?? "75", 10);
  const logDelayMs = Number.parseInt(options["log-rpc-delay-ms"] ?? "25", 10);
  const concurrency = Number.parseInt(options["rpc-concurrency"] ?? "3", 10);
  const maxAttempts = Number.parseInt(options["rpc-max-attempts"] ?? "8", 10);
  if (!Number.isSafeInteger(preferredChunk) || preferredChunk < 1 || preferredChunk > 100_000) {
    throw new Error("--event-chunk-size must be an integer between 1 and 100000.");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("--rpc-concurrency must be an integer between 1 and 12.");
  }
  if (!Number.isSafeInteger(blockBatchSize) || blockBatchSize < 1 || blockBatchSize > 25) {
    throw new Error("--block-batch-size must be an integer between 1 and 25.");
  }
  if (!["block", "block-transactions", "transaction", "transaction-filter"].includes(receiptMode)) {
    throw new Error(
      "--receipt-mode must be block, block-transactions, transaction, or transaction-filter.",
    );
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
    throw new Error("--rpc-delay-ms must be an integer between 0 and 10000.");
  }
  if (!Number.isSafeInteger(logDelayMs) || logDelayMs < 0 || logDelayMs > 10_000) {
    throw new Error("--log-rpc-delay-ms must be an integer between 0 and 10000.");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) {
    throw new Error("--rpc-max-attempts must be an integer between 1 and 12.");
  }
  const blockRpcs = Array.from({ length: concurrency }, () =>
    createBudgetSafeRpcClient({ url: rpcUrl, minDelayMs: delayMs, maxAttempts }),
  );
  const rpc = createBudgetSafeRpcClient({
    url: logRpcUrl,
    minDelayMs: logDelayMs,
    maxAttempts,
  });
  const blocks = await blockRangeForDates(rpc, from, to);
  const result = await collectX402BaseEventRange({
    rpc,
    blockRpcs,
    from,
    to,
    fromBlock: blocks.fromBlock,
    toBlockExclusive: blocks.toBlockExclusive,
    facilitatorRegistry: registry.addresses,
    preferredChunk,
    blockBatchSize,
    receiptMode,
    tokenAddress: registry.tokenAddress,
    includeDistribution: true,
  });
  return {
    sourceKey: "identity:x402:base-usdc:rpc-events:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      provider: new URL(rpcUrl).host,
      logProvider: new URL(logRpcUrl).host,
      from,
      to,
      blockRange: [blocks.fromBlock, blocks.toBlockExclusive],
      rpcConcurrency: concurrency,
      rpcDelayMs: delayMs,
      logRpcDelayMs: logDelayMs,
      blockBatchSize,
      receiptMode,
      rpcMaxAttempts: maxAttempts,
      detector: "authorization-proxy-batch-events-v1",
      transferClassification: "ordered-receive-forward-terminal-v1",
    })),
    collection: result,
    activities: mergeActivities(result.activities),
  };
}

async function collectX402Blockscout(from, to, options) {
  const registry = await loadRegistry(options.registry);
  const blockscoutRequest = createBudgetSafeBlockscoutClient({
    baseUrl: options["blockscout-url"] ?? "https://base.blockscout.com/api",
    minStartDelayMs: Number.parseInt(options["blockscout-delay-ms"] ?? "750", 10),
  });
  const concurrency = Number.parseInt(options["blockscout-concurrency"] ?? "2", 10);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error("--blockscout-concurrency must be an integer between 1 and 6.");
  }
  const [startBlock, endBlockExclusive] = await Promise.all([
    blockscoutBlockForTime(blockscoutRequest, from, "after"),
    blockscoutBlockForTime(blockscoutRequest, to, "after"),
  ]);
  // txlist accepts a complete block interval and paginates it. Querying every
  // facilitator once per day multiplied requests without adding evidence: each
  // returned row already carries its timestamp and block number. Keep the
  // collection range-wide, and let the paginator split only saturated ranges.
  const jobs = registry.addresses
    .filter((entry) => new Date(`${entry.firstSeen}T00:00:00.000Z`) < to)
    .map((entry) => ({
      from,
      to,
      startBlock,
      endBlock: endBlockExclusive - 1,
      address: entry.address.toLowerCase(),
    }));
  const transactions = new Map();
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < jobs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const job = jobs[index];
      const rows = await blockscoutTransactionsForAddress({
        request: blockscoutRequest,
        address: job.address,
        startBlock: job.startBlock,
        endBlock: job.endBlock,
      });
      for (const transaction of rows) transactions.set(transaction.hash, transaction);
      completed += 1;
      if (completed % 50 === 0 || completed === jobs.length) {
        process.stderr.write(
          `Collected x402 Blockscout facilitator ranges ${completed}/${jobs.length}; ` +
            `${transactions.size.toLocaleString()} unique transactions\n`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const result = await collectX402BlockscoutTransactions({
    transactions: [...transactions.values()],
    receiptLoader: (transactionHash) =>
      blockscoutTransactionReceipt(blockscoutRequest, transactionHash),
    tokenAddress: registry.tokenAddress,
  });
  return {
    sourceKey: "identity:x402:base-usdc:blockscout:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      provider: new URL(options["blockscout-url"] ?? "https://base.blockscout.com/api").host,
      from,
      to,
      blockRange: [startBlock, endBlockExclusive],
      facilitatorAddresses: registry.addresses.map((entry) => entry.address.toLowerCase()),
      transferClassification: "ordered-receive-forward-terminal-v1",
      transactionLogFallback: "blockscout-gettxinfo",
    })),
    collection: {
      facilitatorRanges: jobs.length,
      ...result,
      activities: undefined,
    },
    activities: mergeActivities(result.activities),
  };
}

async function collectX402Sqd(from, to, options) {
  const registry = await loadRegistry(options.registry);
  // Do not ask SQD to scan historical transactions from facilitator addresses
  // before those addresses were known to participate in x402. The collector
  // already rejects those transactions after download; filtering the query up
  // front preserves the result while avoiding a very large amount of unrelated
  // Base activity for facilitators that joined later.
  const activeFacilitators = registry.addresses.filter(
    (entry) => new Date(`${entry.firstSeen}T00:00:00.000Z`) < to,
  );
  if (activeFacilitators.length === 0) {
    throw new Error(`No x402 facilitators were active before ${to.toISOString()}.`);
  }
  const rpcUrl = options["rpc-url"] ?? process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is required to resolve the SQD time range.");
  const rpc = createBudgetSafeRpcClient({
    url: rpcUrl,
    minDelayMs: Number.parseInt(options["rpc-delay-ms"] ?? "25", 10),
    maxAttempts: Number.parseInt(options["rpc-max-attempts"] ?? "8", 10),
  });
  const blocks = await blockRangeForDates(rpc, from, to);
  const portal = options["sqd-portal"] ?? DEFAULT_BASE_SQD_PORTAL;
  const result = await collectX402BaseSqdRange({
    portal,
    fromBlock: blocks.fromBlock,
    toBlockExclusive: blocks.toBlockExclusive,
    facilitatorRegistry: activeFacilitators,
    tokenAddress: registry.tokenAddress,
    from,
    to,
    onProgress: options.quiet
      ? undefined
      : ({ batches, matchedBlocks, transactions, lastBlock }) => {
      if (batches % 10 === 0) {
        process.stderr.write(
          `SQD x402 stream: ${batches} batches, ${matchedBlocks} matched blocks, ` +
            `${transactions.toLocaleString()} facilitator transactions through block ${lastBlock}\n`,
        );
      }
    },
  });
  return {
    sourceKey: "identity:x402:base-usdc:sqd-portal:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    evidenceType: "confirmed_chain",
    queryHash: sha256Hex(JSON.stringify({
      provider: new URL(portal).host,
      rangeProvider: new URL(rpcUrl).host,
      from,
      to,
      blockRange: [blocks.fromBlock, blocks.toBlockExclusive],
      facilitatorAddresses: activeFacilitators.map((entry) => entry.address.toLowerCase()),
      transferClassification: "ordered-receive-forward-terminal-v1",
      transactionLogSource: "sqd-portal",
    })),
    collection: {
      ...result,
      activities: undefined,
    },
    activities: mergeActivities(result.activities),
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
    const manifest = await loadIdentityManifest(options.manifest);
    const results = [];
    for (const file of manifest.segmentFiles) {
      const segment = JSON.parse(await readFile(resolve(dirname(manifest.path), file), "utf8"));
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
  const collectionRanges = options.singleRange
    ? [{ from, to, month: "all" }]
    : calendarMonthRanges(from, to);
  for (const range of collectionRanges) {
    const result = options.protocol === "x402"
      ? options.source === "events"
        ? await collectX402Events(range.from, range.to, options)
        : options.source === "rpc"
        ? await collectX402Rpc(range.from, range.to, options)
        : options.source === "blockscout"
          ? await collectX402Blockscout(range.from, range.to, options)
          : options.source === "sqd"
            ? await collectX402Sqd(range.from, range.to, options)
          : await collectX402(range.from, range.to, options)
      : await collectMpp(range.from, range.to, options);
    const segments = makeSegments(result, range.from, range.to);
    const label = `${options.protocol}-${range.from.toISOString().slice(0, 10)}_${range.to.toISOString().slice(0, 10)}`;
    const files = await writeSegments(segments, outputDir, label);
    const ingestion = [];
    for (const segment of segments) ingestion.push(await ingestSegment(segment, options));
    allFiles.push(...files);
    summaries.push({
      month: range.month,
      activities: result.activities.length,
      segments: segments.length,
      collection: result.collection
        ? { ...result.collection, activities: undefined }
        : undefined,
      ingestion,
    });
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
