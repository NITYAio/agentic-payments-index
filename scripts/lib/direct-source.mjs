import { createHash } from "node:crypto";

export const COLLECTOR_VERSION = "2026-08-18.1";
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

        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
          });
        } catch (cause) {
          if (attempt === maxAttempts - 1) {
            const error = new Error(
              `JSON-RPC ${method} network request failed after ${maxAttempts} attempts.`,
              { cause },
            );
            error.nonSplittable = true;
            throw error;
          }
          await sleepImpl(500 * 2 ** attempt);
          continue;
        }
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

export function summarizeTrustPayments(amounts, excludedZeroCount = 0, excludedSelfCount = 0) {
  const sorted = [...amounts].map((amount) => BigInt(amount)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const total = sorted.reduce((sum, amount) => sum + amount, 0n);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length === 0
    ? 0n
    : sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2n;
  const above = (dollars) => sorted.filter((amount) => amount > BigInt(dollars) * 1_000_000n).length;
  return {
    qualifyingPaymentCount: sorted.length,
    qualifyingVolumeUsdMicros: safeNumber(total, "qualifying MPP payment volume"),
    medianPaymentUsdMicros: safeNumber(median, "median MPP payment value"),
    maxPaymentUsdMicros: safeNumber(sorted.at(-1) ?? 0n, "maximum MPP payment value"),
    overOneCount: above(1),
    overTenCount: above(10),
    overHundredCount: above(100),
    overThousandCount: above(1_000),
    excludedZeroCount,
    excludedSelfCount,
  };
}

function classifyTrustCandidates(candidates) {
  const qualifying = [];
  let excludedZeroCount = 0;
  let excludedSelfCount = 0;
  for (const candidate of candidates.values()) {
    if (candidate.self) excludedSelfCount += 1;
    else if (candidate.amount === 0n) excludedZeroCount += 1;
    else qualifying.push(candidate.amount);
  }
  return {
    amounts: qualifying,
    ...summarizeTrustPayments(qualifying, excludedZeroCount, excludedSelfCount),
  };
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
  const windowTrustCandidates = new Map();
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
      trustCandidates: new Map(),
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
    const trustCandidate = day.trustCandidates.get(logicalPayment) ?? { amount: 0n, self: false };
    trustCandidate.amount += amount;
    trustCandidate.self ||= payer === recipient;
    day.trustCandidates.set(logicalPayment, trustCandidate);
    const windowTrustCandidate = windowTrustCandidates.get(logicalPayment) ?? { amount: 0n, self: false };
    windowTrustCandidate.amount += amount;
    windowTrustCandidate.self ||= payer === recipient;
    windowTrustCandidates.set(logicalPayment, windowTrustCandidate);
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
    day.trustCandidates.set(logicalPayment, { amount: deltaPaid, self: payer === payee });
    windowTrustCandidates.set(logicalPayment, { amount: deltaPaid, self: payer === payee });
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
    windowTrust: classifyTrustCandidates(windowTrustCandidates),
    metrics: [...dates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([activityDate, day]) => {
        const trust = classifyTrustCandidates(day.trustCandidates);
        return {
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
        qualifyingPaymentCount: trust.qualifyingPaymentCount,
        qualifyingVolumeUsdMicros: trust.qualifyingVolumeUsdMicros,
        medianPaymentUsdMicros: trust.medianPaymentUsdMicros,
        maxPaymentUsdMicros: trust.maxPaymentUsdMicros,
        overOneCount: trust.overOneCount,
        overTenCount: trust.overTenCount,
        overHundredCount: trust.overHundredCount,
        overThousandCount: trust.overThousandCount,
        excludedZeroCount: trust.excludedZeroCount,
        excludedSelfCount: trust.excludedSelfCount,
        evidenceLevel: "deterministic",
        isAdjusted: false,
        limitation,
      };
      }),
  };
}

export function aggregateTempoLogs(logs, blockTimestamps) {
  return aggregateMppPayments({ chargeLogs: logs, sessionLogs: [], blockTimestamps });
}

export function aggregateMppIdentityActivity({ chargeLogs, sessionLogs, blockTimestamps }) {
  const aggregates = new Map();

  function timestampFor(log) {
    if (typeof log.blockNumber !== "string") return null;
    const timestamp = blockTimestamps.get(Number.parseInt(log.blockNumber, 16));
    if (!timestamp) throw new Error(`Missing timestamp for Tempo block ${log.blockNumber}.`);
    return timestamp;
  }

  function add({ role, scheme, identity, payment, contribution, amount, timestamp }) {
    const activityMonth = timestamp.toISOString().slice(0, 7);
    const normalizedIdentity = identity.toLowerCase();
    const key = [role, scheme, normalizedIdentity, activityMonth].join("|");
    const aggregate = aggregates.get(key) ?? {
      role,
      identityScheme: scheme,
      identityHash: sha256Hex(`mpp|tempo|${scheme}|${normalizedIdentity}`),
      activityMonth,
      payments: new Set(),
      contributions: new Set(),
      volumeUsdMicros: 0n,
      firstSeenAt: timestamp.toISOString(),
      lastSeenAt: timestamp.toISOString(),
      evidenceLevel: "deterministic",
    };
    aggregate.payments.add(payment);
    if (!aggregate.contributions.has(contribution)) {
      aggregate.contributions.add(contribution);
      aggregate.volumeUsdMicros += amount;
    }
    const occurredAt = timestamp.toISOString();
    if (occurredAt < aggregate.firstSeenAt) aggregate.firstSeenAt = occurredAt;
    if (occurredAt > aggregate.lastSeenAt) aggregate.lastSeenAt = occurredAt;
    aggregates.set(key, aggregate);
  }

  for (const log of chargeLogs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    const memo = topics[3];
    if (!TEMPO_USD_TOKENS.has(String(log.address ?? "").toLowerCase())) continue;
    if (!isMppAttributionMemo(memo) || !topics[1]) continue;
    const timestamp = timestampFor(log);
    if (!timestamp || typeof log.transactionHash !== "string") continue;
    const payment = `charge:${log.transactionHash.toLowerCase()}|${memo.toLowerCase()}`;
    const contribution = `${log.transactionHash.toLowerCase()}|${String(log.logIndex ?? "0x0").toLowerCase()}`;
    const amount = BigInt(log.data ?? "0x0");
    add({
      role: "payer",
      scheme: "evm",
      identity: decodeIndexedAddress(topics[1]),
      payment,
      contribution,
      amount,
      timestamp,
    });
    add({
      role: "payee",
      scheme: "mpp-server-fingerprint",
      identity: decodeMppServerFingerprint(memo),
      payment,
      contribution,
      amount,
      timestamp,
    });
  }

  for (const log of sessionLogs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(log.address ?? "").toLowerCase() !== TEMPO_CHANNEL_RESERVE) continue;
    if (String(topics[0] ?? "").toLowerCase() !== TEMPO_SETTLED_TOPIC) continue;
    if (!topics[2] || !topics[3] || typeof log.transactionHash !== "string") continue;
    const words = String(log.data ?? "0x").slice(2).match(/.{64}/g) ?? [];
    if (words.length < 3) continue;
    const timestamp = timestampFor(log);
    if (!timestamp) continue;
    const payment = `session:${log.transactionHash.toLowerCase()}|${String(log.logIndex ?? "0x0").toLowerCase()}`;
    const amount = BigInt(`0x${words[1]}`);
    add({
      role: "payer",
      scheme: "evm",
      identity: decodeIndexedAddress(topics[2]),
      payment,
      contribution: payment,
      amount,
      timestamp,
    });
    add({
      role: "payee",
      scheme: "evm",
      identity: decodeIndexedAddress(topics[3]),
      payment,
      contribution: payment,
      amount,
      timestamp,
    });
  }

  return [...aggregates.values()]
    .map((aggregate) => ({
      role: aggregate.role,
      identityScheme: aggregate.identityScheme,
      identityHash: aggregate.identityHash,
      activityMonth: aggregate.activityMonth,
      transactionCount: aggregate.payments.size,
      volumeUsdMicros: safeNumber(aggregate.volumeUsdMicros, "MPP identity USD volume"),
      firstSeenAt: aggregate.firstSeenAt,
      lastSeenAt: aggregate.lastSeenAt,
      evidenceLevel: aggregate.evidenceLevel,
    }))
    .sort((left, right) =>
      [left.activityMonth, left.role, left.identityScheme, left.identityHash]
        .join("|")
        .localeCompare([right.activityMonth, right.role, right.identityScheme, right.identityHash].join("|")),
    );
}

export function buildX402IdentitySql({ addresses, tokenAddress, from, to, role }) {
  if (role !== "payer" && role !== "payee") throw new Error("x402 identity role is invalid.");
  if (!Array.isArray(addresses) || addresses.length < 1) {
    throw new Error("At least one x402 facilitator address is required.");
  }
  for (const address of [...addresses, tokenAddress]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid Base address: ${address}`);
  }
  const facilitatorList = addresses.map((address) => `'${address}'`).join(",\n        ");
  const identityParameter = role === "payer" ? "from" : "to";
  return `WITH eligible AS (
      SELECT
        block_timestamp,
        transaction_hash,
        parameters['from']::String AS from_address,
        parameters['to']::String AS to_address,
        parameters['value']::UInt256 AS amount
      FROM base.events
      WHERE event_signature = 'Transfer(address,address,uint256)'
        AND address = '${tokenAddress}'
        AND transaction_from IN (
          ${facilitatorList}
        )
        AND block_timestamp >= '${formatSqlTimestamp(from)}'
        AND block_timestamp < '${formatSqlTimestamp(to)}'
        AND action = 'added'
    ), single_leg_hashes AS (
      SELECT transaction_hash
      FROM eligible
      GROUP BY transaction_hash
      HAVING count() = 1
    )
    SELECT
      formatDateTime(block_timestamp, '%Y-%m') AS activity_month,
      lower(${identityParameter === "from" ? "from_address" : "to_address"}) AS identity_key,
      uniqExact(transaction_hash) AS transaction_count,
      sum(amount) AS volume_raw,
      min(block_timestamp) AS first_seen_at,
      max(block_timestamp) AS last_seen_at
    FROM eligible
    WHERE transaction_hash IN (SELECT transaction_hash FROM single_leg_hashes)
    GROUP BY activity_month, identity_key
    ORDER BY activity_month ASC, identity_key ASC`;
}

export function normalizeX402IdentityRows(rows, role) {
  if (!Array.isArray(rows)) throw new Error("CDP SQL identity result must be an array.");
  if (role !== "payer" && role !== "payee") throw new Error("x402 identity role is invalid.");
  return rows.map((row) => {
    const activityMonth = String(row.activity_month ?? "").slice(0, 7);
    const identity = String(row.identity_key ?? "").toLowerCase();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(activityMonth)) {
      throw new Error(`Unexpected x402 activity month: ${activityMonth}`);
    }
    if (!/^0x[0-9a-f]{40}$/.test(identity)) {
      throw new Error("Unexpected x402 identity key.");
    }
    return {
      role,
      identityScheme: "evm",
      identityHash: sha256Hex(`x402|base|evm|${identity}`),
      activityMonth,
      transactionCount: numericResult(row.transaction_count, "x402 identity transaction count"),
      volumeUsdMicros: numericResult(row.volume_raw, "x402 identity USD volume"),
      firstSeenAt: sqlResultTimestamp(row.first_seen_at),
      lastSeenAt: sqlResultTimestamp(row.last_seen_at),
      evidenceLevel: "deterministic",
    };
  });
}

export function buildX402DailySql({ addresses, tokenAddress, from, to }) {
  if (!Array.isArray(addresses) || addresses.length < 1) {
    throw new Error("At least one x402 facilitator address is required.");
  }
  for (const address of [...addresses, tokenAddress]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid Base address: ${address}`);
  }
  const facilitatorList = addresses.map((address) => `'${address}'`).join(",\n        ");
  return `WITH eligible AS (
      SELECT
        block_timestamp,
        transaction_hash,
        lower(parameters['from']::String) AS from_address,
        lower(parameters['to']::String) AS to_address,
        parameters['value']::UInt256 AS amount
      FROM base.events
      WHERE event_signature = 'Transfer(address,address,uint256)'
        AND address = '${tokenAddress}'
        AND transaction_from IN (
          ${facilitatorList}
        )
        AND block_timestamp >= '${formatSqlTimestamp(from)}'
        AND block_timestamp < '${formatSqlTimestamp(to)}'
        AND action = 'added'
    ), single_leg_hashes AS (
      SELECT transaction_hash
      FROM eligible
      GROUP BY transaction_hash
      HAVING count() = 1
    )
    SELECT
      toDate(block_timestamp) AS activity_date,
      count() AS transaction_count,
      count() AS transfer_count,
      groupUniqArray(from_address) AS buyer_addresses,
      groupUniqArray(to_address) AS seller_addresses,
      sum(amount) AS volume_raw
    FROM eligible
    WHERE transaction_hash IN (SELECT transaction_hash FROM single_leg_hashes)
    GROUP BY activity_date
    ORDER BY activity_date ASC`;
}

export function buildX402MultiLegSql({ addresses, tokenAddress, from, to }) {
  if (!Array.isArray(addresses) || addresses.length < 1) {
    throw new Error("At least one x402 facilitator address is required.");
  }
  for (const address of [...addresses, tokenAddress]) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid Base address: ${address}`);
  }
  const facilitatorList = addresses.map((address) => `'${address}'`).join(",\n        ");
  return `WITH eligible AS (
      SELECT
        block_timestamp,
        transaction_hash,
        log_index,
        lower(parameters['from']::String) AS from_address,
        lower(parameters['to']::String) AS to_address,
        parameters['value']::UInt256 AS amount
      FROM base.events
      WHERE event_signature = 'Transfer(address,address,uint256)'
        AND address = '${tokenAddress}'
        AND transaction_from IN (
          ${facilitatorList}
        )
        AND block_timestamp >= '${formatSqlTimestamp(from)}'
        AND block_timestamp < '${formatSqlTimestamp(to)}'
        AND action = 'added'
    ), multi_leg_hashes AS (
      SELECT transaction_hash
      FROM eligible
      GROUP BY transaction_hash
      HAVING count() > 1
    )
    SELECT
      block_timestamp,
      transaction_hash,
      log_index,
      from_address,
      to_address,
      amount
    FROM eligible
    WHERE transaction_hash IN (SELECT transaction_hash FROM multi_leg_hashes)
    ORDER BY block_timestamp ASC, transaction_hash ASC, log_index ASC`;
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
      AND block_timestamp < '${formatSqlTimestamp(to)}'
      AND action = 'added'`;
}

function normalizeAddressArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((address) => {
    const normalized = String(address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
      throw new Error(`Unexpected ${field} address.`);
    }
    return normalized;
  });
}

export function normalizeX402MultiLegRows(rows) {
  if (!Array.isArray(rows)) throw new Error("CDP SQL multi-leg result must be an array.");
  return rows.map((row) => {
    const transactionHash = String(row.transaction_hash ?? "").toLowerCase();
    const from = String(row.from_address ?? "").toLowerCase();
    const to = String(row.to_address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw new Error("Unexpected x402 transaction hash.");
    }
    if (!/^0x[0-9a-f]{40}$/.test(from) || !/^0x[0-9a-f]{40}$/.test(to)) {
      throw new Error("Unexpected x402 transfer address.");
    }
    const timestamp = sqlResultTimestamp(row.block_timestamp);
    const logIndex = numericResult(row.log_index, "x402 log index");
    return {
      transactionHash,
      from,
      to,
      amountRaw: BigInt(String(row.amount ?? "0")),
      logIndex,
      timestamp,
      activityDate: timestamp.slice(0, 10),
    };
  });
}

export function collapseX402TransferChains(transfers) {
  if (!Array.isArray(transfers)) throw new Error("x402 transfers must be an array.");
  const byTransaction = new Map();
  for (const transfer of transfers) {
    const legs = byTransaction.get(transfer.transactionHash) ?? [];
    legs.push(transfer);
    byTransaction.set(transfer.transactionHash, legs);
  }

  const collapsed = [];
  for (const legs of byTransaction.values()) {
    const sorted = [...legs].sort((left, right) => left.logIndex - right.logIndex);
    const position = new Map(sorted.map((leg, index) => [leg, index]));
    const firstReceived = new Map();
    const lastSent = new Map();
    sorted.forEach((leg, index) => {
      if (!firstReceived.has(leg.to)) firstReceived.set(leg.to, index);
      lastSent.set(leg.from, index);
    });
    const isPassThrough = (address) => {
      const received = firstReceived.get(address);
      const sent = lastSent.get(address);
      return received !== undefined && sent !== undefined && received < sent;
    };
    const consumed = new Set();

    for (const origin of sorted) {
      if (consumed.has(origin) || isPassThrough(origin.from)) continue;
      consumed.add(origin);
      let rawLegCount = 1;
      let terminal = origin;
      while (isPassThrough(terminal.to)) {
        const candidates = sorted.filter(
          (leg) =>
            !consumed.has(leg) &&
            leg.from === terminal.to &&
            position.get(leg) > position.get(terminal),
        );
        if (candidates.length === 0) break;
        const target = terminal.amountRaw;
        const next = candidates.reduce((best, leg) => {
          const bestDistance = best.amountRaw > target ? best.amountRaw - target : target - best.amountRaw;
          const legDistance = leg.amountRaw > target ? leg.amountRaw - target : target - leg.amountRaw;
          return legDistance < bestDistance ? leg : best;
        });
        consumed.add(next);
        rawLegCount += 1;
        terminal = next;
      }
      collapsed.push(
        terminal === origin
          ? { ...origin, recipientAmountRaw: origin.amountRaw, rawLegCount }
          : {
              ...origin,
              to: terminal.to,
              recipientAmountRaw: terminal.amountRaw,
              rawLegCount,
            },
      );
    }
  }
  return collapsed;
}

export function x402TerminalIdentityActivities(transfers) {
  const payments = collapseX402TransferChains(normalizeX402MultiLegRows(transfers));
  const activities = new Map();
  const add = (payment, role, identity, amountRaw) => {
    const activityMonth = payment.activityDate.slice(0, 7);
    const identityHash = sha256Hex(`x402|base|evm|${identity}`);
    const key = [role, identityHash, activityMonth].join("|");
    const current = activities.get(key) ?? {
      role,
      identityScheme: "evm",
      identityHash,
      activityMonth,
      transactionCount: 0,
      volumeRaw: 0n,
      firstSeenAt: payment.timestamp,
      lastSeenAt: payment.timestamp,
      evidenceLevel: "deterministic",
    };
    current.transactionCount += 1;
    current.volumeRaw += amountRaw;
    if (payment.timestamp < current.firstSeenAt) current.firstSeenAt = payment.timestamp;
    if (payment.timestamp > current.lastSeenAt) current.lastSeenAt = payment.timestamp;
    activities.set(key, current);
  };
  for (const payment of payments) {
    add(payment, "payer", payment.from, payment.amountRaw);
    add(payment, "payee", payment.to, payment.recipientAmountRaw);
  }
  return [...activities.values()]
    .map(({ volumeRaw, ...activity }) => ({
      ...activity,
      volumeUsdMicros: safeNumber(volumeRaw, "x402 terminal identity USD volume"),
    }))
    .sort((left, right) =>
      [left.activityMonth, left.role, left.identityHash]
        .join("|")
        .localeCompare([right.activityMonth, right.role, right.identityHash].join("|")),
    );
}

export function aggregateX402TerminalPayments({ singleRows, multiLegRows, from, to }) {
  if (!(from instanceof Date) || !(to instanceof Date) || to <= from) {
    throw new Error("A valid x402 aggregation range is required.");
  }
  const byDate = new Map();
  const windowBuyers = new Set();
  const windowSellers = new Set();
  let windowTransactionCount = 0;
  let windowPaymentVolumeRaw = 0n;
  let windowRecipientVolumeRaw = 0n;
  let windowGrossVolumeRaw = 0n;
  let windowRawTransferCount = 0;

  const day = (activityDate) => {
    const value = byDate.get(activityDate) ?? {
      activityDate,
      transactionCount: 0,
      rawTransferCount: 0,
      paymentVolumeRaw: 0n,
      recipientVolumeRaw: 0n,
      grossVolumeRaw: 0n,
      buyers: new Set(),
      sellers: new Set(),
    };
    byDate.set(activityDate, value);
    return value;
  };

  for (const row of singleRows) {
    const activityDate = String(row.activity_date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(activityDate)) {
      throw new Error(`Unexpected CDP activity date: ${activityDate}`);
    }
    const current = day(activityDate);
    const count = numericResult(row.transaction_count, "x402 single-leg transaction count");
    const volume = BigInt(String(row.volume_raw ?? "0"));
    const buyers = normalizeAddressArray(row.buyer_addresses, "x402 buyer");
    const sellers = normalizeAddressArray(row.seller_addresses, "x402 seller");
    current.transactionCount += count;
    current.rawTransferCount += numericResult(row.transfer_count, "x402 single-leg transfer count");
    current.paymentVolumeRaw += volume;
    current.recipientVolumeRaw += volume;
    current.grossVolumeRaw += volume;
    for (const buyer of buyers) {
      current.buyers.add(buyer);
      windowBuyers.add(buyer);
    }
    for (const seller of sellers) {
      current.sellers.add(seller);
      windowSellers.add(seller);
    }
    windowTransactionCount += count;
    windowPaymentVolumeRaw += volume;
    windowRecipientVolumeRaw += volume;
    windowGrossVolumeRaw += volume;
    windowRawTransferCount += count;
  }

  const normalizedMulti = normalizeX402MultiLegRows(multiLegRows);
  const collapsed = collapseX402TransferChains(normalizedMulti);
  for (const leg of normalizedMulti) {
    const current = day(leg.activityDate);
    current.rawTransferCount += 1;
    current.grossVolumeRaw += leg.amountRaw;
    windowRawTransferCount += 1;
    windowGrossVolumeRaw += leg.amountRaw;
  }
  for (const payment of collapsed) {
    const current = day(payment.activityDate);
    current.transactionCount += 1;
    current.paymentVolumeRaw += payment.amountRaw;
    current.recipientVolumeRaw += payment.recipientAmountRaw;
    current.buyers.add(payment.from);
    current.sellers.add(payment.to);
    windowBuyers.add(payment.from);
    windowSellers.add(payment.to);
    windowTransactionCount += 1;
    windowPaymentVolumeRaw += payment.amountRaw;
    windowRecipientVolumeRaw += payment.recipientAmountRaw;
  }

  const limitation =
    "Base USDC settlements submitted by the versioned public facilitator registry. Each receive-then-forward proxy chain counts once at the payer's original amount and is attributed to the terminal recipient using ordered transfer logs. Terminal recipient net value and gross transfer movement are retained separately. Testing, self-payment, unresolved ownership, non-Base, and non-USDC activity remain unadjusted.";
  const metrics = [...byDate.values()]
    .map((value) => ({
      activityDate: value.activityDate,
      measurementUnit: "onchain_settlement",
      transactionCount: value.transactionCount,
      settlementCount: value.transactionCount,
      rawTransferCount: value.rawTransferCount,
      volumeUsdMicros: safeNumber(value.paymentVolumeRaw, "x402 terminal payment USD volume"),
      recipientVolumeUsdMicros: safeNumber(
        value.recipientVolumeRaw,
        "x402 terminal recipient USD volume",
      ),
      grossVolumeUsdMicros: safeNumber(value.grossVolumeRaw, "x402 gross transfer USD volume"),
      buyerCount: value.buyers.size,
      sellerCount: value.sellers.size,
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    }))
    .sort((left, right) => left.activityDate.localeCompare(right.activityDate));

  return {
    metrics,
    windowSummary: {
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      measurementUnit: "onchain_settlement",
      transactionCount: windowTransactionCount,
      settlementCount: windowTransactionCount,
      rawTransferCount: windowRawTransferCount,
      volumeUsdMicros: safeNumber(windowPaymentVolumeRaw, "x402 terminal payment window USD volume"),
      recipientVolumeUsdMicros: safeNumber(
        windowRecipientVolumeRaw,
        "x402 terminal recipient window USD volume",
      ),
      grossVolumeUsdMicros: safeNumber(windowGrossVolumeRaw, "x402 gross transfer window USD volume"),
      buyerCount: windowBuyers.size,
      sellerCount: windowSellers.size,
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    },
  };
}

function trustAmountHistogram(amounts) {
  const counts = new Map();
  for (const value of amounts) {
    const amount = BigInt(value).toString();
    counts.set(amount, (counts.get(amount) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => {
      const leftAmount = BigInt(left);
      const rightAmount = BigInt(right);
      return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
    })
    .map(([amountUsdMicros, count]) => ({ amountUsdMicros, count }));
}

function summarizeTrustPaymentHistogram(histogram, excludedZeroCount, excludedSelfCount) {
  const rows = [...histogram.entries()]
    .map(([amount, count]) => ({ amount: BigInt(amount), count }))
    .sort((left, right) => left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : 0);
  const qualifyingPaymentCount = rows.reduce((total, row) => total + row.count, 0);
  const qualifyingVolume = rows.reduce(
    (total, row) => total + row.amount * BigInt(row.count),
    0n,
  );
  const amountAt = (position) => {
    let cursor = 0;
    for (const row of rows) {
      cursor += row.count;
      if (position < cursor) return row.amount;
    }
    return 0n;
  };
  const lower = qualifyingPaymentCount === 0
    ? 0n
    : amountAt(Math.floor((qualifyingPaymentCount - 1) / 2));
  const upper = qualifyingPaymentCount === 0
    ? 0n
    : amountAt(Math.floor(qualifyingPaymentCount / 2));
  const above = (dollars) => rows.reduce(
    (total, row) => total + (row.amount > BigInt(dollars) * 1_000_000n ? row.count : 0),
    0,
  );
  return {
    qualifyingPaymentCount,
    qualifyingVolumeUsdMicros: safeNumber(
      qualifyingVolume,
      "qualifying x402 payment volume",
    ),
    medianPaymentUsdMicros: safeNumber((lower + upper) / 2n, "median x402 payment value"),
    maxPaymentUsdMicros: safeNumber(
      rows.at(-1)?.amount ?? 0n,
      "maximum x402 payment value",
    ),
    overOneCount: above(1),
    overTenCount: above(10),
    overHundredCount: above(100),
    overThousandCount: above(1_000),
    excludedZeroCount,
    excludedSelfCount,
  };
}

export function aggregateX402EventPayments({ payments, from, to, includeDistribution = false }) {
  if (!(from instanceof Date) || !(to instanceof Date) || to <= from) {
    throw new Error("A valid x402 event aggregation range is required.");
  }
  if (!Array.isArray(payments)) throw new Error("x402 event payments must be an array.");

  const byDate = new Map();
  const windowBuyers = new Set();
  const windowSellers = new Set();
  const windowTrustAmounts = [];
  let windowPaymentVolumeRaw = 0n;
  let windowRecipientVolumeRaw = 0n;
  let windowGrossVolumeRaw = 0n;
  let windowRawTransferCount = 0;
  let windowExcludedZeroCount = 0;
  let windowExcludedSelfCount = 0;

  const day = (activityDate) => {
    const value = byDate.get(activityDate) ?? {
      activityDate,
      transactionCount: 0,
      rawTransferCount: 0,
      paymentVolumeRaw: 0n,
      recipientVolumeRaw: 0n,
      grossVolumeRaw: 0n,
      buyers: new Set(),
      sellers: new Set(),
      trustAmounts: [],
      excludedZeroCount: 0,
      excludedSelfCount: 0,
    };
    byDate.set(activityDate, value);
    return value;
  };

  for (const payment of payments) {
    const timestamp = new Date(payment.timestamp);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid x402 event timestamp.");
    if (timestamp < from || timestamp >= to) continue;
    const activityDate = timestamp.toISOString().slice(0, 10);
    const amountRaw = BigInt(payment.amountRaw);
    const recipientAmountRaw = BigInt(payment.recipientAmountRaw ?? payment.amountRaw);
    const grossVolumeRaw = BigInt(payment.grossVolumeRaw ?? payment.amountRaw);
    const rawLegCount = Number(payment.rawLegCount ?? 1);
    if (!Number.isSafeInteger(rawLegCount) || rawLegCount < 1) {
      throw new Error("Invalid x402 raw transfer count.");
    }
    const buyer = String(payment.from ?? "").toLowerCase();
    const seller = String(payment.to ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(buyer) || !/^0x[0-9a-f]{40}$/.test(seller)) {
      throw new Error("Invalid x402 event identity.");
    }

    const current = day(activityDate);
    current.transactionCount += 1;
    current.rawTransferCount += rawLegCount;
    current.paymentVolumeRaw += amountRaw;
    current.recipientVolumeRaw += recipientAmountRaw;
    current.grossVolumeRaw += grossVolumeRaw;
    current.buyers.add(buyer);
    current.sellers.add(seller);
    windowBuyers.add(buyer);
    windowSellers.add(seller);
    windowPaymentVolumeRaw += amountRaw;
    windowRecipientVolumeRaw += recipientAmountRaw;
    windowGrossVolumeRaw += grossVolumeRaw;
    windowRawTransferCount += rawLegCount;

    if (buyer === seller) {
      current.excludedSelfCount += 1;
      windowExcludedSelfCount += 1;
    } else if (amountRaw === 0n) {
      current.excludedZeroCount += 1;
      windowExcludedZeroCount += 1;
    } else {
      current.trustAmounts.push(amountRaw);
      windowTrustAmounts.push(amountRaw);
    }
  }

  const limitation =
    "Base USDC settlements detected from x402 authorization, proxy-settlement, and batch-claim events. " +
    "Receive-then-forward chains count once at the payer's original amount and resolve to the terminal recipient. " +
    "Zero-value and self-payments are excluded from ticket-size metrics. Unresolved ownership, non-Base, and non-USDC activity remain outside coverage.";
  const metrics = [...byDate.values()]
    .map((value) => ({
      activityDate: value.activityDate,
      measurementUnit: "onchain_settlement",
      transactionCount: value.transactionCount,
      settlementCount: value.transactionCount,
      rawTransferCount: value.rawTransferCount,
      volumeUsdMicros: safeNumber(value.paymentVolumeRaw, "x402 event payment USD volume"),
      recipientVolumeUsdMicros: safeNumber(
        value.recipientVolumeRaw,
        "x402 event recipient USD volume",
      ),
      grossVolumeUsdMicros: safeNumber(value.grossVolumeRaw, "x402 event gross USD volume"),
      buyerCount: value.buyers.size,
      sellerCount: value.sellers.size,
      ...summarizeTrustPayments(
        value.trustAmounts,
        value.excludedZeroCount,
        value.excludedSelfCount,
      ),
      ...(includeDistribution
        ? { trustAmountHistogram: trustAmountHistogram(value.trustAmounts) }
        : {}),
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    }))
    .sort((left, right) => left.activityDate.localeCompare(right.activityDate));

  return {
    metrics,
    windowSummary: {
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      measurementUnit: "onchain_settlement",
      transactionCount: metrics.reduce((total, metric) => total + metric.transactionCount, 0),
      settlementCount: metrics.reduce((total, metric) => total + metric.settlementCount, 0),
      rawTransferCount: windowRawTransferCount,
      volumeUsdMicros: safeNumber(windowPaymentVolumeRaw, "x402 event payment window USD volume"),
      recipientVolumeUsdMicros: safeNumber(
        windowRecipientVolumeRaw,
        "x402 event recipient window USD volume",
      ),
      grossVolumeUsdMicros: safeNumber(windowGrossVolumeRaw, "x402 event gross window USD volume"),
      buyerCount: windowBuyers.size,
      sellerCount: windowSellers.size,
      ...summarizeTrustPayments(
        windowTrustAmounts,
        windowExcludedZeroCount,
        windowExcludedSelfCount,
      ),
      ...(includeDistribution
        ? { trustAmountHistogram: trustAmountHistogram(windowTrustAmounts) }
        : {}),
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    },
  };
}

// The SQD history collector can observe millions of dense Base transactions in a
// single day. This accumulator preserves the exact public aggregation while
// retaining only identity sets and an amount histogram between stream batches.
// Raw transactions, receipts, transfers, and payment objects can therefore be
// released as soon as each batch has been classified.
export function createX402EventPaymentAccumulator({
  from,
  to,
  includeDistribution = false,
}) {
  if (!(from instanceof Date) || !(to instanceof Date) || to <= from) {
    throw new Error("A valid x402 event aggregation range is required.");
  }

  const byDate = new Map();
  const windowBuyers = new Set();
  const windowSellers = new Set();
  const windowTrustHistogram = new Map();
  let windowPaymentVolumeRaw = 0n;
  let windowRecipientVolumeRaw = 0n;
  let windowGrossVolumeRaw = 0n;
  let windowRawTransferCount = 0;
  let windowExcludedZeroCount = 0;
  let windowExcludedSelfCount = 0;
  let finished = false;

  const day = (activityDate) => {
    const value = byDate.get(activityDate) ?? {
      activityDate,
      transactionCount: 0,
      rawTransferCount: 0,
      paymentVolumeRaw: 0n,
      recipientVolumeRaw: 0n,
      grossVolumeRaw: 0n,
      buyers: new Set(),
      sellers: new Set(),
      trustHistogram: new Map(),
      excludedZeroCount: 0,
      excludedSelfCount: 0,
    };
    byDate.set(activityDate, value);
    return value;
  };

  const incrementHistogram = (histogram, amount) => {
    const key = amount.toString();
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  };

  function add(payments) {
    if (finished) throw new Error("The x402 event accumulator has already been finalized.");
    if (!Array.isArray(payments)) throw new Error("x402 event payments must be an array.");
    for (const payment of payments) {
      const timestamp = new Date(payment.timestamp);
      if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid x402 event timestamp.");
      if (timestamp < from || timestamp >= to) continue;
      const activityDate = timestamp.toISOString().slice(0, 10);
      const amountRaw = BigInt(payment.amountRaw);
      const recipientAmountRaw = BigInt(payment.recipientAmountRaw ?? payment.amountRaw);
      const grossVolumeRaw = BigInt(payment.grossVolumeRaw ?? payment.amountRaw);
      const rawLegCount = Number(payment.rawLegCount ?? 1);
      if (!Number.isSafeInteger(rawLegCount) || rawLegCount < 1) {
        throw new Error("Invalid x402 raw transfer count.");
      }
      const buyer = String(payment.from ?? "").toLowerCase();
      const seller = String(payment.to ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(buyer) || !/^0x[0-9a-f]{40}$/.test(seller)) {
        throw new Error("Invalid x402 event identity.");
      }

      const current = day(activityDate);
      current.transactionCount += 1;
      current.rawTransferCount += rawLegCount;
      current.paymentVolumeRaw += amountRaw;
      current.recipientVolumeRaw += recipientAmountRaw;
      current.grossVolumeRaw += grossVolumeRaw;
      current.buyers.add(buyer);
      current.sellers.add(seller);
      windowBuyers.add(buyer);
      windowSellers.add(seller);
      windowPaymentVolumeRaw += amountRaw;
      windowRecipientVolumeRaw += recipientAmountRaw;
      windowGrossVolumeRaw += grossVolumeRaw;
      windowRawTransferCount += rawLegCount;

      if (buyer === seller) {
        current.excludedSelfCount += 1;
        windowExcludedSelfCount += 1;
      } else if (amountRaw === 0n) {
        current.excludedZeroCount += 1;
        windowExcludedZeroCount += 1;
      } else {
        incrementHistogram(current.trustHistogram, amountRaw);
        incrementHistogram(windowTrustHistogram, amountRaw);
      }
    }
  }

  function finish() {
    if (finished) throw new Error("The x402 event accumulator has already been finalized.");
    finished = true;
    const limitation =
      "Base USDC settlements detected from x402 authorization, proxy-settlement, and batch-claim events. " +
      "Receive-then-forward chains count once at the payer's original amount and resolve to the terminal recipient. " +
      "Zero-value and self-payments are excluded from ticket-size metrics. Unresolved ownership, non-Base, and non-USDC activity remain outside coverage.";
    const distribution = (histogram) => [...histogram.entries()]
      .sort(([left], [right]) => {
        const leftAmount = BigInt(left);
        const rightAmount = BigInt(right);
        return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
      })
      .map(([amountUsdMicros, count]) => ({ amountUsdMicros, count }));
    const metrics = [...byDate.values()]
      .map((value) => ({
        activityDate: value.activityDate,
        measurementUnit: "onchain_settlement",
        transactionCount: value.transactionCount,
        settlementCount: value.transactionCount,
        rawTransferCount: value.rawTransferCount,
        volumeUsdMicros: safeNumber(value.paymentVolumeRaw, "x402 event payment USD volume"),
        recipientVolumeUsdMicros: safeNumber(
          value.recipientVolumeRaw,
          "x402 event recipient USD volume",
        ),
        grossVolumeUsdMicros: safeNumber(value.grossVolumeRaw, "x402 event gross USD volume"),
        buyerCount: value.buyers.size,
        sellerCount: value.sellers.size,
        ...summarizeTrustPaymentHistogram(
          value.trustHistogram,
          value.excludedZeroCount,
          value.excludedSelfCount,
        ),
        ...(includeDistribution
          ? { trustAmountHistogram: distribution(value.trustHistogram) }
          : {}),
        evidenceLevel: "deterministic",
        isAdjusted: false,
        limitation,
      }))
      .sort((left, right) => left.activityDate.localeCompare(right.activityDate));

    return {
      metrics,
      windowSummary: {
        rangeStart: from.toISOString(),
        rangeEnd: to.toISOString(),
        measurementUnit: "onchain_settlement",
        transactionCount: metrics.reduce((total, metric) => total + metric.transactionCount, 0),
        settlementCount: metrics.reduce((total, metric) => total + metric.settlementCount, 0),
        rawTransferCount: windowRawTransferCount,
        volumeUsdMicros: safeNumber(
          windowPaymentVolumeRaw,
          "x402 event payment window USD volume",
        ),
        recipientVolumeUsdMicros: safeNumber(
          windowRecipientVolumeRaw,
          "x402 event recipient window USD volume",
        ),
        grossVolumeUsdMicros: safeNumber(
          windowGrossVolumeRaw,
          "x402 event gross USD volume",
        ),
        buyerCount: windowBuyers.size,
        sellerCount: windowSellers.size,
        ...summarizeTrustPaymentHistogram(
          windowTrustHistogram,
          windowExcludedZeroCount,
          windowExcludedSelfCount,
        ),
        ...(includeDistribution
          ? { trustAmountHistogram: distribution(windowTrustHistogram) }
          : {}),
        evidenceLevel: "deterministic",
        isAdjusted: false,
        limitation,
      },
    };
  }

  return { add, finish };
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
        rawTransferCount: 0,
        chargeCount: 0,
        sessionCount: 0,
        volumeUsdMicros: 0,
        recipientVolumeUsdMicros: 0,
        grossVolumeUsdMicros: 0,
        chargeVolumeUsdMicros: 0,
        sessionVolumeUsdMicros: 0,
        buyerCount: 0,
        sellerCount: 0,
        qualifyingPaymentCount: 0,
        qualifyingVolumeUsdMicros: 0,
        medianPaymentUsdMicros: 0,
        maxPaymentUsdMicros: 0,
        overOneCount: 0,
        overTenCount: 0,
        overHundredCount: 0,
        overThousandCount: 0,
        excludedZeroCount: 0,
        excludedSelfCount: 0,
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

function sqlResultTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("SQL timestamp is missing.");
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`Unexpected SQL timestamp: ${value}`);
  return timestamp.toISOString();
}
