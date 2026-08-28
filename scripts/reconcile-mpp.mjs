#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MPP_SCAN_URL =
  "https://mppscan.com/api/trpc/stats.protocolStats,stats.bucketed?batch=1&input=" +
  encodeURIComponent(
    JSON.stringify({
      0: { json: { timeframeDays: 30 } },
      1: { json: { timeframeDays: 30 } },
    }),
  );

const DEFAULT_TEMPO_RPC = "https://rpc.tempo.xyz";
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const STRICT_TOKENS = new Set([PATH_USD, USDC_E]);
const MPP_TAG = "ef1ed712";
const MPP_VERSION = "01";
const CHANNEL_RESERVE = "0x4d50500000000000000000000000000000000000";

// keccak256 hashes of the canonical event signatures from the Tempo contracts.
// Keeping these local avoids depending on the optional web3_sha3 RPC method.
const EVENT_TOPICS = {
  transferWithMemo: "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0",
  channelOpened: "0xdebaba36f0e9c7978f536fed432d9360b1f9646d7ca88531c34c3eae43f154a7",
  settled: "0x11c4e4c79ad8802431b44c15047ed1ddb82fbfc1abd452c765f7ee3990df1399",
  topUp: "0x2a96f534665f3150977dd4c35d91373c74030288edbb3cf83c527dd25012364f",
  closeRequested: "0xf5a36fc00a96cbb9cf1f8f59299165e1d8ffffe94396d82904b4da524d16bbce",
  channelClosed: "0x5613aed96d5bf39f928408dbe1d4143490b9bb5957eac2dd8e69b5dc4b2206e6",
  closeRequestCancelled: "0x6bbcbc59913c43e567847487b95410b0b65cf253531b1c6505b21f8359c838fe",
};

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
    options[value.slice(2)] = next;
    index += 1;
  }
  return options;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function createRpc(url) {
  if (!url) throw new Error("TEMPO_RPC_URL is required.");
  let requestId = 0;
  let lastRequestAt = 0;
  let queue = Promise.resolve();

  return function rpc(method, params) {
    const id = ++requestId;
    const run = queue.then(async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const delay = Math.max(0, lastRequestAt + 75 - Date.now());
        if (delay) await wait(delay);
        lastRequestAt = Date.now();

        let response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          });
        } catch (error) {
          if (attempt === 5) throw error;
          await wait(500 * 2 ** attempt);
          continue;
        }

        const bodyText = await response.text();
        let body;
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }

        if (response.ok && !body?.error) return body?.result;

        const message = body?.error?.message ?? (bodyText.slice(0, 240) || "unknown RPC error");
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < 5) {
          await wait(500 * 2 ** attempt);
          continue;
        }

        const rpcError = new Error(`Tempo ${method} failed (${response.status}): ${message}`);
        rpcError.splittable = method === "eth_getLogs";
        throw rpcError;
      }
      throw new Error(`Tempo ${method} exhausted its retry budget.`);
    });

    queue = run.catch(() => undefined);
    return run;
  };
}

async function fetchMppScan() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(MPP_SCAN_URL, {
        headers: {
          accept: "application/json",
          "x-trpc-source": "agentic-payments-index-reconciliation",
        },
      });
      if (!response.ok) throw new Error(`MPPScan returned ${response.status}.`);
      const payload = await response.json();
      const stats = payload[0]?.result?.data?.json;
      const buckets = payload[1]?.result?.data?.json;
      if (!stats || !Array.isArray(buckets) || buckets.length === 0) {
        throw new Error("MPPScan returned an incompatible payload.");
      }
      const responseDate = new Date(response.headers.get("date") ?? Date.now());
      return { stats, buckets, responseDate };
    } catch (error) {
      if (attempt === 5) throw error;
      await wait(1_000 * 2 ** attempt);
    }
  }
  throw new Error("MPPScan request exhausted its retry budget.");
}

function hexQuantity(number) {
  return `0x${number.toString(16)}`;
}

function decodeAddressTopic(topic) {
  return `0x${String(topic).slice(-40)}`.toLowerCase();
}

function dataWords(data) {
  const raw = String(data ?? "0x").slice(2);
  if (raw.length % 64 !== 0) return [];
  const words = [];
  for (let index = 0; index < raw.length; index += 64) {
    words.push(raw.slice(index, index + 64));
  }
  return words;
}

function wordAddress(word) {
  return `0x${word.slice(-40)}`.toLowerCase();
}

function wordBigInt(word) {
  return BigInt(`0x${word || "0"}`);
}

async function firstBlockAtOrAfter(rpc, latest, target, blockCache) {
  let low = 0;
  let high = latest + 1;
  async function timestamp(number) {
    if (!blockCache.has(number)) {
      const block = await rpc("eth_getBlockByNumber", [hexQuantity(number), false]);
      if (!block) throw new Error(`Tempo block ${number} was not found.`);
      blockCache.set(number, Number.parseInt(block.timestamp, 16) * 1_000);
    }
    return blockCache.get(number);
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (middle > latest || (await timestamp(middle)) >= target.getTime()) high = middle;
    else low = middle + 1;
  }
  return low;
}

async function getLogs(rpc, filter, fromBlock, toBlockExclusive) {
  const logs = [];
  async function range(start, end) {
    if (end < start) return;
    try {
      const result = await rpc("eth_getLogs", [
        {
          ...filter,
          fromBlock: hexQuantity(start),
          toBlock: hexQuantity(end),
        },
      ]);
      logs.push(...result);
    } catch (error) {
      if (!error.splittable || start === end) throw error;
      const middle = Math.floor((start + end) / 2);
      await range(start, middle);
      await range(middle + 1, end);
    }
  }

  const preferredChunk = 25_000;
  for (let start = fromBlock; start < toBlockExclusive; start += preferredChunk) {
    await range(start, Math.min(toBlockExclusive - 1, start + preferredChunk - 1));
  }
  return logs;
}

function emptyChargeState() {
  return {
    allTransferWithMemoLogs: 0,
    validMppLogsAllTokens: 0,
    validMppLogicalPaymentsAllTokens: new Set(),
    strictLogs: 0,
    strictLogicalPayments: new Set(),
    strictTransactionHashes: new Set(),
    strictVolumeRaw: 0n,
    validMppVolumeRawAllTokens: 0n,
    mppTagOtherVersionLogs: 0,
    nonMppMemoLogs: 0,
    payerAddresses: new Set(),
    recipientAddresses: new Set(),
    serverFingerprints: new Set(),
    clientFingerprints: new Set(),
    anonymousClientLogs: 0,
    versions: new Map(),
    tokens: new Map(),
  };
}

function classifyChargeLogs(logs, state) {
  for (const log of logs) {
    state.allTransferWithMemoLogs += 1;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const memo = String(topics[3] ?? "").toLowerCase();
    const token = String(log.address ?? "").toLowerCase();
    const amount = BigInt(log.data ?? "0x0");
    const tokenState = state.tokens.get(token) ?? {
      allLogs: 0,
      validMppLogs: 0,
      validMppVolumeRaw: 0n,
    };
    tokenState.allLogs += 1;

    const tagMatches = memo.length === 66 && memo.slice(2, 10) === MPP_TAG;
    const version = memo.slice(10, 12);
    if (tagMatches) state.versions.set(version, (state.versions.get(version) ?? 0) + 1);
    const validMpp = tagMatches && version === MPP_VERSION;

    if (!validMpp) {
      if (tagMatches) state.mppTagOtherVersionLogs += 1;
      else state.nonMppMemoLogs += 1;
      state.tokens.set(token, tokenState);
      continue;
    }

    const transactionHash = String(log.transactionHash ?? "").toLowerCase();
    const logicalPayment = `${transactionHash}|${memo}`;
    const payer = decodeAddressTopic(topics[1]);
    const recipient = decodeAddressTopic(topics[2]);
    const serverFingerprint = `0x${memo.slice(12, 32)}`;
    const clientHex = memo.slice(32, 52);

    state.validMppLogsAllTokens += 1;
    state.validMppLogicalPaymentsAllTokens.add(logicalPayment);
    state.validMppVolumeRawAllTokens += amount;
    state.payerAddresses.add(payer);
    state.recipientAddresses.add(recipient);
    state.serverFingerprints.add(serverFingerprint);
    if (/^0+$/.test(clientHex)) state.anonymousClientLogs += 1;
    else state.clientFingerprints.add(`0x${clientHex}`);
    tokenState.validMppLogs += 1;
    tokenState.validMppVolumeRaw += amount;

    if (STRICT_TOKENS.has(token)) {
      state.strictLogs += 1;
      state.strictLogicalPayments.add(logicalPayment);
      state.strictTransactionHashes.add(transactionHash);
      state.strictVolumeRaw += amount;
    }
    state.tokens.set(token, tokenState);
  }
}

function emptySessionState() {
  return {
    channelOpened: 0,
    settled: 0,
    settledDeltaRaw: 0n,
    topUp: 0,
    closeRequested: 0,
    channelClosed: 0,
    closeRequestCancelled: 0,
    otherLogs: 0,
    payerAddresses: new Set(),
    payeeAddresses: new Set(),
    openedTokens: new Map(),
  };
}

function classifySessionLogs(logs, topics, state) {
  for (const log of logs) {
    const eventTopic = String(log.topics?.[0] ?? "").toLowerCase();
    const words = dataWords(log.data);
    if (eventTopic === topics.channelOpened) {
      state.channelOpened += 1;
      if (words[1]) {
        const token = wordAddress(words[1]);
        state.openedTokens.set(token, (state.openedTokens.get(token) ?? 0) + 1);
      }
    } else if (eventTopic === topics.settled) {
      state.settled += 1;
      if (words[1]) state.settledDeltaRaw += wordBigInt(words[1]);
    } else if (eventTopic === topics.topUp) state.topUp += 1;
    else if (eventTopic === topics.closeRequested) state.closeRequested += 1;
    else if (eventTopic === topics.channelClosed) state.channelClosed += 1;
    else if (eventTopic === topics.closeRequestCancelled) state.closeRequestCancelled += 1;
    else state.otherLogs += 1;

    if (log.topics?.[2]) state.payerAddresses.add(decodeAddressTopic(log.topics[2]));
    if (log.topics?.[3]) state.payeeAddresses.add(decodeAddressTopic(log.topics[3]));
  }
}

function mergeSets(target, source) {
  for (const item of source) target.add(item);
}

function mergeChargeState(target, source) {
  for (const key of [
    "allTransferWithMemoLogs",
    "validMppLogsAllTokens",
    "strictLogs",
    "mppTagOtherVersionLogs",
    "nonMppMemoLogs",
    "anonymousClientLogs",
  ]) {
    target[key] += source[key];
  }
  target.strictVolumeRaw += source.strictVolumeRaw;
  target.validMppVolumeRawAllTokens += source.validMppVolumeRawAllTokens;
  for (const key of [
    "validMppLogicalPaymentsAllTokens",
    "strictLogicalPayments",
    "strictTransactionHashes",
    "payerAddresses",
    "recipientAddresses",
    "serverFingerprints",
    "clientFingerprints",
  ]) {
    mergeSets(target[key], source[key]);
  }
  for (const [key, value] of source.versions) {
    target.versions.set(key, (target.versions.get(key) ?? 0) + value);
  }
  for (const [token, value] of source.tokens) {
    const current = target.tokens.get(token) ?? {
      allLogs: 0,
      validMppLogs: 0,
      validMppVolumeRaw: 0n,
    };
    current.allLogs += value.allLogs;
    current.validMppLogs += value.validMppLogs;
    current.validMppVolumeRaw += value.validMppVolumeRaw;
    target.tokens.set(token, current);
  }
}

function mergeSessionState(target, source) {
  for (const key of [
    "channelOpened",
    "settled",
    "topUp",
    "closeRequested",
    "channelClosed",
    "closeRequestCancelled",
    "otherLogs",
  ]) {
    target[key] += source[key];
  }
  target.settledDeltaRaw += source.settledDeltaRaw;
  mergeSets(target.payerAddresses, source.payerAddresses);
  mergeSets(target.payeeAddresses, source.payeeAddresses);
  for (const [token, value] of source.openedTokens) {
    target.openedTokens.set(token, (target.openedTokens.get(token) ?? 0) + value);
  }
}

function serializeChargeState(state) {
  return {
    allTransferWithMemoLogs: state.allTransferWithMemoLogs,
    validMppLogsAllTokens: state.validMppLogsAllTokens,
    validMppLogicalPaymentsAllTokens: state.validMppLogicalPaymentsAllTokens.size,
    strictLogs: state.strictLogs,
    strictLogicalPayments: state.strictLogicalPayments.size,
    strictTransactionHashes: state.strictTransactionHashes.size,
    strictVolumeUsd: Number(state.strictVolumeRaw) / 1_000_000,
    validMppVolumeUsdAllTokensAssumingSixDecimals:
      Number(state.validMppVolumeRawAllTokens) / 1_000_000,
    mppTagOtherVersionLogs: state.mppTagOtherVersionLogs,
    nonMppMemoLogs: state.nonMppMemoLogs,
    payerAddresses: state.payerAddresses.size,
    recipientAddresses: state.recipientAddresses.size,
    serverFingerprints: state.serverFingerprints.size,
    nonAnonymousClientFingerprints: state.clientFingerprints.size,
    anonymousClientLogs: state.anonymousClientLogs,
    versions: Object.fromEntries([...state.versions].sort(([left], [right]) => left.localeCompare(right))),
    tokens: Object.fromEntries(
      [...state.tokens]
        .sort(([, left], [, right]) => right.validMppLogs - left.validMppLogs)
        .map(([token, value]) => [
          token,
          {
            allLogs: value.allLogs,
            validMppLogs: value.validMppLogs,
            validMppVolumeRaw: value.validMppVolumeRaw.toString(),
          },
        ]),
    ),
  };
}

function serializeSessionState(state) {
  return {
    channelOpened: state.channelOpened,
    settled: state.settled,
    settledDeltaUsdAssumingSixDecimals: Number(state.settledDeltaRaw) / 1_000_000,
    topUp: state.topUp,
    closeRequested: state.closeRequested,
    channelClosed: state.channelClosed,
    closeRequestCancelled: state.closeRequestCancelled,
    otherLogs: state.otherLogs,
    payerAddresses: state.payerAddresses.size,
    payeeAddresses: state.payeeAddresses.size,
    openedTokens: Object.fromEntries(
      [...state.openedTokens].sort(([, left], [, right]) => right - left),
    ),
  };
}

function candidateSummary(buckets, formula) {
  const rows = buckets.map((bucket) => {
    const candidate = formula(bucket);
    const delta = candidate - bucket.mppScan.transactions;
    return { start: bucket.start, mppScan: bucket.mppScan.transactions, candidate, delta };
  });
  const mppScan = rows.reduce((total, row) => total + row.mppScan, 0);
  const candidate = rows.reduce((total, row) => total + row.candidate, 0);
  const absoluteError = rows.reduce((total, row) => total + Math.abs(row.delta), 0);
  return {
    mppScan,
    candidate,
    delta: candidate - mppScan,
    percentDelta: mppScan ? ((candidate - mppScan) / mppScan) * 100 : null,
    meanAbsoluteBucketError: rows.length ? absoluteError / rows.length : null,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const rpcUrl = options["rpc-url"] ?? process.env.TEMPO_RPC_URL ?? DEFAULT_TEMPO_RPC;
  const rpc = createRpc(rpcUrl);
  const scan = await fetchMppScan();

  const topics = EVENT_TOPICS;

  const latest = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const blockCache = new Map();
  const boundaryDates = [
    ...scan.buckets.map((bucket) => new Date(bucket.bucket_start)),
    scan.responseDate,
  ];
  const boundaryBlocks = [];
  for (const boundary of boundaryDates) {
    boundaryBlocks.push(await firstBlockAtOrAfter(rpc, latest, boundary, blockCache));
  }

  const aggregateCharges = emptyChargeState();
  const aggregateSessions = emptySessionState();
  const bucketResults = [];

  for (let index = 0; index < scan.buckets.length; index += 1) {
    const scanBucket = scan.buckets[index];
    const fromBlock = boundaryBlocks[index];
    const toBlockExclusive = boundaryBlocks[index + 1];
    const [chargeLogs, sessionLogs] = await Promise.all([
      getLogs(rpc, { topics: [topics.transferWithMemo] }, fromBlock, toBlockExclusive),
      getLogs(rpc, { address: CHANNEL_RESERVE }, fromBlock, toBlockExclusive),
    ]);
    const charges = emptyChargeState();
    const sessions = emptySessionState();
    classifyChargeLogs(chargeLogs, charges);
    classifySessionLogs(sessionLogs, topics, sessions);
    mergeChargeState(aggregateCharges, charges);
    mergeSessionState(aggregateSessions, sessions);
    bucketResults.push({
      start: scanBucket.bucket_start,
      end: boundaryDates[index + 1].toISOString(),
      fromBlock,
      toBlockExclusive,
      mppScan: {
        transactions: scanBucket.total_transactions,
        volumeUsd: scanBucket.total_volume,
        uniqueSenders: scanBucket.unique_senders,
        uniqueRecipients: scanBucket.unique_recipients,
      },
      direct: {
        charges: serializeChargeState(charges),
        sessions: serializeSessionState(sessions),
      },
    });
    process.stderr.write(`Reconciled bucket ${index + 1}/${scan.buckets.length}\n`);
  }

  const candidates = {
    strictCharges: candidateSummary(
      bucketResults,
      (bucket) => bucket.direct.charges.strictLogicalPayments,
    ),
    allTokenMppCharges: candidateSummary(
      bucketResults,
      (bucket) => bucket.direct.charges.validMppLogicalPaymentsAllTokens,
    ),
    strictChargesPlusSessionSettlements: candidateSummary(
      bucketResults,
      (bucket) => bucket.direct.charges.strictLogicalPayments + bucket.direct.sessions.settled,
    ),
    allTokenMppChargesPlusSessionSettlements: candidateSummary(
      bucketResults,
      (bucket) =>
        bucket.direct.charges.validMppLogicalPaymentsAllTokens + bucket.direct.sessions.settled,
    ),
    allTokenMppChargesPlusSettlementsAndCloses: candidateSummary(
      bucketResults,
      (bucket) =>
        bucket.direct.charges.validMppLogicalPaymentsAllTokens +
        bucket.direct.sessions.settled +
        bucket.direct.sessions.channelClosed,
    ),
  };

  const bucketSumTransactions = scan.buckets.reduce(
    (total, bucket) => total + bucket.total_transactions,
    0,
  );
  const bucketSumVolume = scan.buckets.reduce(
    (total, bucket) => total + bucket.total_volume,
    0,
  );
  const result = {
    generatedAt: new Date().toISOString(),
    purpose: "Internal MPPScan reconciliation; not a public product data source.",
    sourceWindow: {
      mppScanResponseDate: scan.responseDate.toISOString(),
      firstBucketStart: scan.buckets[0].bucket_start,
      lastBucketEnd: scan.responseDate.toISOString(),
      bucketCount: scan.buckets.length,
      effectiveHours:
        (scan.responseDate.getTime() - new Date(scan.buckets[0].bucket_start).getTime()) /
        3_600_000,
      note:
        "Direct events are queried over the exact 48 bucket boundaries returned by MPPScan. Its live headline and materialized bucket sums can differ slightly at collection time.",
    },
    mppScan: {
      ...scan.stats,
      bucketSumTransactions,
      bucketSumVolume,
    },
    direct: {
      charges: serializeChargeState(aggregateCharges),
      sessions: serializeSessionState(aggregateSessions),
    },
    candidateComparisons: candidates,
    caveats: [
      "MPPScan's private inclusion query is not available; candidate formulas are differential tests, not claims about its implementation.",
      "Session settled delta is displayed as USD only under the six-decimal stablecoin assumption; opened-token coverage is reported separately.",
      "ChannelClosed reports cumulative settled value, not the final incremental capture, so close volume is not inferred.",
      "MPP server fingerprints, client fingerprints, payer addresses, and recipient addresses are distinct identity concepts.",
    ],
    buckets: bucketResults,
  };

  const outputPath = resolve(
    options.output ?? `data/reconciliation/mpp-internal-${scan.responseDate.toISOString().replaceAll(":", "")}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        outputPath,
        mppScan: result.mppScan,
        direct: result.direct,
        candidateComparisons: result.candidateComparisons,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
