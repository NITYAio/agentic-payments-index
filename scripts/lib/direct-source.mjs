import { createHash } from "node:crypto";

export const COLLECTOR_VERSION = "2026-08-10.1";
export const MPP_MEMO_PREFIX = "0xef1ed71201";
export const TEMPO_CHANNEL_RESERVE = "0x4d50500000000000000000000000000000000000";
export const TEMPO_SETTLED_TOPIC =
  "0x11c4e4c79ad8802431b44c15047ed1ddb82fbfc1abd452c765f7ee3990df1399";
export const TEMPO_USD_TOKENS = new Set([
  "0x20c0000000000000000000000000000000000000",
  "0x20c000000000000000000000b9537d11c60e8b50",
]);

export function createJsonRpcClient({
  url,
  fetchImpl = fetch,
  minDelayMs = 150,
  maxAttempts = 6,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!url) throw new Error("A JSON-RPC URL is required.");
  let id = 0;
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function enqueue(method, params) {
    const requestId = ++id;
    const run = queue.then(async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const waitForSlot = Math.max(0, lastRequestAt + minDelayMs - Date.now());
        if (waitForSlot > 0) await sleepImpl(waitForSlot);
        lastRequestAt = Date.now();

        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        });
        if (response.ok) {
          const body = await response.json();
          if (body.error) {
            const error = new Error(
              `JSON-RPC ${method} failed: ${body.error.message ?? "unknown error"}`,
            );
            error.nonSplittable = false;
            throw error;
          }
          return body.result;
        }

        const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        if (!retryable || attempt === maxAttempts - 1) {
          const error = new Error(`JSON-RPC ${method} failed (${response.status}).`);
          error.nonSplittable = !(method === "eth_getLogs" && response.status === 400);
          throw error;
        }
        const retryAfterSeconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
        const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0;
        await sleepImpl(Math.max(retryAfterMs, 500 * 2 ** attempt));
      }
      throw new Error(`JSON-RPC ${method} exhausted its retry budget.`);
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return enqueue;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseDateRange(fromValue, toValue) {
  if (!fromValue) throw new Error("--from is required (YYYY-MM-DD or ISO timestamp).");
  const from = new Date(/^\d{4}-\d{2}-\d{2}$/.test(fromValue) ? `${fromValue}T00:00:00.000Z` : fromValue);
  const to = toValue
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(toValue) ? `${toValue}T00:00:00.000Z` : toValue)
    : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error("The requested date range is invalid.");
  }
  if (to <= from) throw new Error("--to must be after --from.");
  if (to.getTime() > Date.now() + 86_400_000) throw new Error("--to cannot be in the future.");
  return { from, to };
}

export function splitUtcDateRange(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date) || to <= from) {
    throw new Error("A valid increasing UTC date range is required.");
  }
  const windows = [];
  let cursor = new Date(from);
  while (cursor < to) {
    const nextMidnight = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1),
    );
    const end = nextMidnight < to ? nextMidnight : new Date(to);
    windows.push({ from: new Date(cursor), to: end });
    cursor = end;
  }
  return windows;
}

export function buildTempoLogFilter({ fromBlock, toBlockExclusive, eventTopic }) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlockExclusive) || toBlockExclusive <= fromBlock) {
    throw new Error("A valid Tempo block range is required.");
  }
  return {
    address: [...TEMPO_USD_TOKENS],
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${(toBlockExclusive - 1).toString(16)}`,
    topics: [eventTopic],
  };
}

export function buildTempoSessionLogFilter({ fromBlock, toBlockExclusive }) {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlockExclusive) || toBlockExclusive <= fromBlock) {
    throw new Error("A valid Tempo block range is required.");
  }
  return {
    address: TEMPO_CHANNEL_RESERVE,
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${(toBlockExclusive - 1).toString(16)}`,
    topics: [TEMPO_SETTLED_TOPIC],
  };
}

export function isMppAttributionMemo(value) {
  return (
    typeof value === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(value) &&
    value.toLowerCase().startsWith(MPP_MEMO_PREFIX)
  );
}

export function decodeIndexedAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error("Indexed address topic is invalid.");
  }
  return `0x${topic.slice(-40)}`.toLowerCase();
}

export function decodeMppServerFingerprint(memo) {
  if (!isMppAttributionMemo(memo)) throw new Error("MPP attribution memo is invalid.");
  return `0x${memo.slice(12, 32)}`.toLowerCase();
}

export function aggregateMppPayments({ chargeLogs, sessionLogs, blockTimestamps }) {
  const dates = new Map();
  const windowPayments = new Set();
  const windowChargePayments = new Set();
  const windowSessionPayments = new Set();
  const windowSettlements = new Set();
  const windowBuyers = new Set();
  const windowServerFingerprints = new Set();
  const windowRecipientAddresses = new Set();
  const windowSessionPayees = new Set();
  let acceptedLogCount = 0;
  let acceptedChargeLogCount = 0;
  let acceptedSessionLogCount = 0;

  function dayFor(log) {
    if (typeof log.transactionHash !== "string" || typeof log.blockNumber !== "string") return null;
    const blockNumber = Number.parseInt(log.blockNumber, 16);
    const timestamp = blockTimestamps.get(blockNumber);
    if (!timestamp) throw new Error(`Missing timestamp for Tempo block ${blockNumber}.`);
    const activityDate = timestamp.toISOString().slice(0, 10);
    const day = dates.get(activityDate) ?? {
      payments: new Set(),
      chargePayments: new Set(),
      sessionPayments: new Set(),
      settlements: new Set(),
      buyers: new Set(),
      serverFingerprints: new Set(),
      recipientAddresses: new Set(),
      sessionPayees: new Set(),
      volumeUsdMicros: 0n,
      chargeVolumeUsdMicros: 0n,
      sessionVolumeUsdMicros: 0n,
    };
    dates.set(activityDate, day);
    return day;
  }

  for (const log of chargeLogs) {
    const address = String(log.address ?? "").toLowerCase();
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const memo = topics[3];
    if (!TEMPO_USD_TOKENS.has(address) || !isMppAttributionMemo(memo)) continue;
    const day = dayFor(log);
    if (!day) continue;
    const payer = decodeIndexedAddress(topics[1]);
    const recipient = decodeIndexedAddress(topics[2]);
    const serverFingerprint = decodeMppServerFingerprint(memo);
    const amount = BigInt(log.data ?? "0x0");
    const logicalPayment = `charge:${log.transactionHash.toLowerCase()}|${memo.toLowerCase()}`;
    const transactionHash = log.transactionHash.toLowerCase();
    day.payments.add(logicalPayment);
    day.chargePayments.add(logicalPayment);
    day.settlements.add(transactionHash);
    day.buyers.add(payer);
    day.serverFingerprints.add(serverFingerprint);
    day.recipientAddresses.add(recipient);
    day.volumeUsdMicros += amount;
    day.chargeVolumeUsdMicros += amount;
    windowPayments.add(logicalPayment);
    windowChargePayments.add(logicalPayment);
    windowSettlements.add(transactionHash);
    windowBuyers.add(payer);
    windowServerFingerprints.add(serverFingerprint);
    windowRecipientAddresses.add(recipient);
    acceptedLogCount += 1;
    acceptedChargeLogCount += 1;
  }

  for (const log of sessionLogs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(log.address ?? "").toLowerCase() !== TEMPO_CHANNEL_RESERVE) continue;
    if (String(topics[0] ?? "").toLowerCase() !== TEMPO_SETTLED_TOPIC) continue;
    const day = dayFor(log);
    if (!day || !topics[2] || !topics[3]) continue;
    const words = String(log.data ?? "0x").slice(2).match(/.{64}/g) ?? [];
    if (words.length < 3) continue;
    const payer = decodeIndexedAddress(topics[2]);
    const payee = decodeIndexedAddress(topics[3]);
    const deltaPaid = BigInt(`0x${words[1]}`);
    const transactionHash = log.transactionHash.toLowerCase();
    const logicalPayment = `session:${transactionHash}|${String(log.logIndex ?? "0x0").toLowerCase()}`;
    day.payments.add(logicalPayment);
    day.sessionPayments.add(logicalPayment);
    day.settlements.add(transactionHash);
    day.buyers.add(payer);
    day.sessionPayees.add(payee);
    day.volumeUsdMicros += deltaPaid;
    day.sessionVolumeUsdMicros += deltaPaid;
    windowPayments.add(logicalPayment);
    windowSessionPayments.add(logicalPayment);
    windowSettlements.add(transactionHash);
    windowBuyers.add(payer);
    windowSessionPayees.add(payee);
    acceptedLogCount += 1;
    acceptedSessionLogCount += 1;
  }
  const limitation =
    "Counts current-version MPP charges in pathUSD and USDC.e plus TIP-1034 Settled session events; session value uses deltaPaid. " +
    "Active server identities are memo fingerprints observed on charges. NANOUSD, invalid or older memos, and off-chain vouchers not yet settled are excluded.";
  return {
    acceptedLogCount,
    acceptedChargeLogCount,
    acceptedSessionLogCount,
    windowSets: {
      payments: windowPayments,
      chargePayments: windowChargePayments,
      sessionPayments: windowSessionPayments,
      settlements: windowSettlements,
      buyers: windowBuyers,
      sellers: windowServerFingerprints,
      serverFingerprints: windowServerFingerprints,
      recipientAddresses: windowRecipientAddresses,
      sessionPayees: windowSessionPayees,
    },
    metrics: [...dates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([activityDate, day]) => ({
        activityDate,
        measurementUnit: "protocol_payment",
        transactionCount: day.payments.size,
        chargeCount: day.chargePayments.size,
        sessionCount: day.sessionPayments.size,
        settlementCount: day.settlements.size,
        volumeUsdMicros: safeNumber(day.volumeUsdMicros, "Tempo USD volume"),
        chargeVolumeUsdMicros: safeNumber(day.chargeVolumeUsdMicros, "Tempo charge USD volume"),
        sessionVolumeUsdMicros: safeNumber(day.sessionVolumeUsdMicros, "Tempo session USD volume"),
        buyerCount: day.buyers.size,
        sellerCount: day.serverFingerprints.size,
        evidenceLevel: "deterministic",
        isAdjusted: false,
        limitation,
      })),
  };
}

export function aggregateTempoLogs(logs, blockTimestamps) {
  return aggregateMppPayments({ chargeLogs: logs, sessionLogs: [], blockTimestamps });
}

export function buildX402DailySql({ addresses, tokenAddress, from, to }) {
  if (!Array.isArray(addresses) || addresses.length < 1) {
    throw new Error("At least one x402 facilitator address is required.");
  }
  for (const address of [...addresses, tokenAddress]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid Base address: ${address}`);
  }
  const facilitatorList = addresses.map((address) => `'${address}'`).join(",\n        ");
  return `SELECT
      toDate(block_timestamp) AS activity_date,
      uniqExact(transaction_hash) AS transaction_count,
      count() AS transfer_count,
      uniqExact(parameters['from']::String) AS buyer_count,
      uniqExact(parameters['to']::String) AS seller_count,
      sum(parameters['value']::UInt256) AS volume_raw
    FROM base.events
    WHERE event_signature = 'Transfer(address,address,uint256)'
      AND address = '${tokenAddress}'
      AND transaction_from IN (
        ${facilitatorList}
      )
      AND block_timestamp >= '${formatSqlTimestamp(from)}'
      AND block_timestamp < '${formatSqlTimestamp(to)}'
    GROUP BY activity_date
    ORDER BY activity_date ASC`;
}

export function buildX402WindowSql({ addresses, tokenAddress, from, to }) {
  if (!Array.isArray(addresses) || addresses.length < 1) {
    throw new Error("At least one x402 facilitator address is required.");
  }
  for (const address of [...addresses, tokenAddress]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid Base address: ${address}`);
  }
  const facilitatorList = addresses.map((address) => `'${address}'`).join(",\n        ");
  return `SELECT
      uniqExact(transaction_hash) AS transaction_count,
      count() AS transfer_count,
      uniqExact(parameters['from']::String) AS buyer_count,
      uniqExact(parameters['to']::String) AS seller_count,
      sum(parameters['value']::UInt256) AS volume_raw
    FROM base.events
    WHERE event_signature = 'Transfer(address,address,uint256)'
      AND address = '${tokenAddress}'
      AND transaction_from IN (
        ${facilitatorList}
      )
      AND block_timestamp >= '${formatSqlTimestamp(from)}'
      AND block_timestamp < '${formatSqlTimestamp(to)}'`;
}

export function normalizeX402DailyRows(rows) {
  if (!Array.isArray(rows)) throw new Error("CDP SQL response result must be an array.");
  const limitation =
    "Base USDC transactions submitted by the public facilitator-address registry. Transaction hashes are deduplicated, " +
    "but proxy pass-through transfer volume and identities remain unadjusted; non-Base and non-USDC x402 payments are excluded.";
  return rows.map((row) => {
    const activityDate = String(row.activity_date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate)) {
      throw new Error(`Unexpected CDP activity date: ${activityDate}`);
    }
    return {
      activityDate,
      measurementUnit: "onchain_settlement",
      transactionCount: numericResult(row.transaction_count, "x402 transaction count"),
      settlementCount: numericResult(row.transaction_count, "x402 settlement count"),
      volumeUsdMicros: numericResult(row.volume_raw, "x402 USD volume"),
      buyerCount: numericResult(row.buyer_count, "x402 buyer count"),
      sellerCount: numericResult(row.seller_count, "x402 seller count"),
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    };
  });
}

export function normalizeX402WindowRow(row) {
  if (!row || typeof row !== "object") throw new Error("CDP SQL window response is missing.");
  return {
    measurementUnit: "onchain_settlement",
    transactionCount: numericResult(row.transaction_count, "x402 window transaction count"),
    settlementCount: numericResult(row.transaction_count, "x402 window settlement count"),
    volumeUsdMicros: numericResult(row.volume_raw, "x402 window USD volume"),
    buyerCount: numericResult(row.buyer_count, "x402 window buyer count"),
    sellerCount: numericResult(row.seller_count, "x402 window seller count"),
    evidenceLevel: "deterministic",
    isAdjusted: false,
    limitation:
      "Base USDC transactions submitted by the public facilitator-address registry. Transaction hashes and period identities are deduplicated, " +
      "but proxy pass-through transfer volume and identity ownership remain unadjusted; non-Base and non-USDC x402 payments are excluded.",
  };
}

export function x402InputRowCount(rows) {
  return rows.reduce(
    (total, row) => total + numericResult(row.transfer_count, "x402 transfer count"),
    0,
  );
}

export function fillDailyMetricRange(from, to, metrics, template) {
  const byDate = new Map(metrics.map((metric) => [metric.activityDate, metric]));
  const result = [];
  for (
    let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    cursor < to;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    result.push(
      byDate.get(date) ?? {
        ...template,
        activityDate: date,
        transactionCount: 0,
        settlementCount: 0,
        chargeCount: 0,
        sessionCount: 0,
        volumeUsdMicros: 0,
        chargeVolumeUsdMicros: 0,
        sessionVolumeUsdMicros: 0,
        buyerCount: 0,
        sellerCount: 0,
      },
    );
  }
  return result;
}

function numericResult(value, field) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${field} is missing.`);
  }
  const integer = BigInt(value);
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the supported safe-integer range.`);
  }
  return Number(integer);
}

function safeNumber(value, field) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the supported safe-integer range.`);
  }
  return Number(value);
}

function formatSqlTimestamp(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
