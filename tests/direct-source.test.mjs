import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateMppPayments,
  aggregateMppIdentityActivity,
  aggregateTempoLogs,
  aggregateX402TerminalPayments,
  buildTempoLogFilter,
  buildTempoSessionLogFilter,
  buildX402DailySql,
  buildX402IdentitySql,
  buildX402MultiLegSql,
  buildX402WindowSql,
  createJsonRpcClient,
  fillDailyMetricRange,
  isMppAttributionMemo,
  normalizeX402DailyRows,
  normalizeX402IdentityRows,
  normalizeX402WindowRow,
  splitUtcDateRange,
  TEMPO_CHANNEL_RESERVE,
  TEMPO_SETTLED_TOPIC,
  x402TerminalIdentityActivities,
} from "../scripts/lib/direct-source.mjs";

const payerTopic = `0x${"0".repeat(24)}1111111111111111111111111111111111111111`;
const sellerOneTopic = `0x${"0".repeat(24)}2222222222222222222222222222222222222222`;
const sellerTwoTopic = `0x${"0".repeat(24)}3333333333333333333333333333333333333333`;
const mppMemoOne = `0xef1ed71201${"a".repeat(54)}`;
const mppMemoTwo = `0xef1ed71201${"b".repeat(54)}`;

test("UTC ranges split at midnight without gaps or overlap", () => {
  const windows = splitUtcDateRange(
    new Date("2026-08-07T12:00:00.000Z"),
    new Date("2026-08-09T06:00:00.000Z"),
  );
  assert.deepEqual(
    windows.map(({ from, to }) => [from.toISOString(), to.toISOString()]),
    [
      ["2026-08-07T12:00:00.000Z", "2026-08-08T00:00:00.000Z"],
      ["2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
      ["2026-08-09T00:00:00.000Z", "2026-08-09T06:00:00.000Z"],
    ],
  );
});

test("Tempo log queries filter at the RPC layer to the two supported USD assets", () => {
  const filter = buildTempoLogFilter({
    fromBlock: 100,
    toBlockExclusive: 200,
    eventTopic: "0xevent",
  });
  assert.deepEqual(filter.address, [
    "0x20c0000000000000000000000000000000000000",
    "0x20c000000000000000000000b9537d11c60e8b50",
  ]);
  assert.equal(filter.fromBlock, "0x64");
  assert.equal(filter.toBlock, "0xc7");
  assert.deepEqual(filter.topics, ["0xevent"]);
});

test("Tempo session queries target only TIP-1034 Settled events", () => {
  const filter = buildTempoSessionLogFilter({ fromBlock: 100, toBlockExclusive: 200 });
  assert.equal(filter.address, TEMPO_CHANNEL_RESERVE);
  assert.deepEqual(filter.topics, [TEMPO_SETTLED_TOPIC]);
  assert.equal(filter.fromBlock, "0x64");
  assert.equal(filter.toBlock, "0xc7");
});

test("JSON-RPC collection backs off on rate limits and preserves request identity", async () => {
  const requestIds = [];
  let calls = 0;
  const rpc = createJsonRpcClient({
    url: "https://rpc.example",
    minDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      requestIds.push(JSON.parse(init.body).id);
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: requestIds[0], result: "0x2a" });
    },
  });
  assert.equal(await rpc("eth_blockNumber", []), "0x2a");
  assert.deepEqual(requestIds, [1, 1]);
});

test("JSON-RPC collection retries transient network failures", async () => {
  const requestIds = [];
  let calls = 0;
  const rpc = createJsonRpcClient({
    url: "https://rpc.example",
    minDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      requestIds.push(JSON.parse(init.body).id);
      if (calls === 1) throw new TypeError("fetch failed");
      return Response.json({ jsonrpc: "2.0", id: requestIds[0], result: "0x2a" });
    },
  });
  assert.equal(await rpc("eth_blockNumber", []), "0x2a");
  assert.deepEqual(requestIds, [1, 1]);
});

test("MPP attribution memos require the official tag, version, and 32-byte length", () => {
  assert.equal(isMppAttributionMemo(mppMemoOne), true);
  assert.equal(isMppAttributionMemo(`0xef1ed71202${"a".repeat(54)}`), false);
  assert.equal(isMppAttributionMemo("0xef1ed71201"), false);
});

test("Tempo aggregation counts a split charge once and sums its recipients", () => {
  const logs = [
    tempoLog({ data: "0x0f4240", index: 1, memo: mppMemoOne, seller: sellerOneTopic }),
    tempoLog({ data: "0x1e8480", index: 2, memo: mppMemoOne, seller: sellerTwoTopic }),
    tempoLog({ data: "0x2dc6c0", index: 3, memo: mppMemoTwo, seller: sellerOneTopic }),
    tempoLog({
      data: "0x3d0900",
      index: 4,
      memo: `0x${"9".repeat(64)}`,
      seller: sellerOneTopic,
    }),
  ];
  const result = aggregateTempoLogs(
    logs,
    new Map([[10, new Date("2026-08-07T12:00:00.000Z")]]),
  );
  assert.equal(result.acceptedLogCount, 3);
  assert.equal(result.windowSets.payments.size, 2);
  assert.equal(result.windowSets.settlements.size, 1);
  assert.equal(result.windowSets.buyers.size, 1);
  assert.equal(result.windowSets.sellers.size, 2);
  assert.deepEqual(result.metrics[0], {
    activityDate: "2026-08-07",
    measurementUnit: "protocol_payment",
    transactionCount: 2,
    chargeCount: 2,
    sessionCount: 0,
    settlementCount: 1,
    volumeUsdMicros: 6_000_000,
    chargeVolumeUsdMicros: 6_000_000,
    sessionVolumeUsdMicros: 0,
    buyerCount: 1,
    sellerCount: 2,
    qualifyingPaymentCount: 2,
    qualifyingVolumeUsdMicros: 6_000_000,
    medianPaymentUsdMicros: 3_000_000,
    maxPaymentUsdMicros: 3_000_000,
    overOneCount: 2,
    overTenCount: 0,
    overHundredCount: 0,
    overThousandCount: 0,
    excludedZeroCount: 0,
    excludedSelfCount: 0,
    evidenceLevel: "deterministic",
    isAdjusted: false,
    limitation:
      "Counts current-version MPP charges in pathUSD and USDC.e plus TIP-1034 Settled session events; session value uses deltaPaid. " +
      "Active server identities are memo fingerprints observed on charges. NANOUSD, invalid or older memos, and off-chain vouchers not yet settled are excluded.",
  });
});

test("MPP Trust Barometer excludes zero-value and self-payments", () => {
  const result = aggregateMppPayments({
    chargeLogs: [
      tempoLog({ data: "0x0", index: 1, memo: mppMemoOne, seller: sellerOneTopic }),
      tempoLog({ data: "0x1e8480", index: 2, memo: mppMemoTwo, seller: payerTopic }),
      tempoLog({ data: "0x2dc6c0", index: 3, memo: `0xef1ed71201${"c".repeat(54)}`, seller: sellerTwoTopic }),
    ],
    sessionLogs: [],
    blockTimestamps: new Map([[10, new Date("2026-08-07T12:00:00.000Z")]]),
  });
  assert.equal(result.metrics[0].transactionCount, 3, "market activity remains unadjusted");
  assert.equal(result.metrics[0].qualifyingPaymentCount, 1);
  assert.equal(result.metrics[0].qualifyingVolumeUsdMicros, 3_000_000);
  assert.equal(result.metrics[0].overOneCount, 1);
  assert.equal(result.metrics[0].excludedZeroCount, 1);
  assert.equal(result.metrics[0].excludedSelfCount, 1);
});

test("MPP aggregation combines charges and session settlements without mixing identity schemes", () => {
  const charge = tempoLog({ data: "0x0f4240", index: 1, memo: mppMemoOne, seller: sellerOneTopic });
  const session = tempoSessionLog({
    data: abiWords(3_000_000n, 2_000_000n, 3_000_000n),
    index: 2,
    payer: payerTopic,
    payee: sellerTwoTopic,
  });
  const result = aggregateMppPayments({
    chargeLogs: [charge],
    sessionLogs: [session],
    blockTimestamps: new Map([[10, new Date("2026-08-07T12:00:00.000Z")]]),
  });
  assert.equal(result.acceptedChargeLogCount, 1);
  assert.equal(result.acceptedSessionLogCount, 1);
  assert.equal(result.windowSets.buyers.size, 1);
  assert.equal(result.windowSets.sellers.size, 1, "server identities come from MPP memos");
  assert.equal(result.windowSets.sessionPayees.size, 1);
  assert.equal(result.metrics[0].transactionCount, 2);
  assert.equal(result.metrics[0].chargeCount, 1);
  assert.equal(result.metrics[0].sessionCount, 1);
  assert.equal(result.metrics[0].volumeUsdMicros, 3_000_000);
  assert.equal(result.metrics[0].chargeVolumeUsdMicros, 1_000_000);
  assert.equal(result.metrics[0].sessionVolumeUsdMicros, 2_000_000);
});

test("MPP identity activity is hashed locally and keeps service identity schemes explicit", () => {
  const activity = aggregateMppIdentityActivity({
    chargeLogs: [
      tempoLog({ data: "0x0f4240", index: 1, memo: mppMemoOne, seller: sellerOneTopic }),
      tempoLog({ data: "0x1e8480", index: 2, memo: mppMemoOne, seller: sellerTwoTopic }),
    ],
    sessionLogs: [
      tempoSessionLog({
        data: abiWords(3_000_000n, 2_000_000n, 3_000_000n),
        index: 3,
        payer: payerTopic,
        payee: sellerTwoTopic,
      }),
    ],
    blockTimestamps: new Map([[10, new Date("2026-08-07T12:00:00.000Z")]]),
  });
  assert.equal(activity.filter((row) => row.role === "payer").length, 1);
  assert.equal(activity.find((row) => row.role === "payer").transactionCount, 2);
  assert.equal(activity.find((row) => row.identityScheme === "mpp-server-fingerprint").transactionCount, 1);
  assert.equal(activity.some((row) => JSON.stringify(row).includes("1111111111111111")), false);
});

test("x402 SQL pins Base USDC, facilitators, and an exact half-open window", () => {
  const sql = buildX402DailySql({
    addresses: ["0x1111111111111111111111111111111111111111"],
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.match(sql, /HAVING count\(\) = 1/);
  assert.match(sql, /groupUniqArray\(from_address\)/);
  assert.match(sql, /transaction_from IN/);
  assert.match(sql, /action = 'added'/);
  assert.match(sql, /2026-08-01 00:00:00\.000/);
  assert.match(sql, /2026-08-08 00:00:00\.000/);
});

test("x402 window SQL and normalization preserve period-wide distinct identities", () => {
  const sql = buildX402WindowSql({
    addresses: ["0x1111111111111111111111111111111111111111"],
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.match(sql, /uniqExact\(parameters\['from'\]::String\) AS buyer_count/);
  const summary = normalizeX402WindowRow({
    transaction_count: "12",
    transfer_count: "14",
    buyer_count: "4",
    seller_count: "6",
    volume_raw: "2500000",
  });
  assert.equal(summary.buyerCount, 4);
  assert.equal(summary.sellerCount, 6);
  assert.equal(summary.transactionCount, 12);
});

test("x402 identity SQL selects a role and hashes normalized output", () => {
  const sql = buildX402IdentitySql({
    addresses: ["0x1111111111111111111111111111111111111111"],
    tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-09-01T00:00:00.000Z"),
    role: "payee",
  });
  assert.match(sql, /lower\(to_address\)/);
  assert.match(sql, /HAVING count\(\) = 1/);
  const rows = normalizeX402IdentityRows(
    [{
      activity_month: "2026-08",
      identity_key: "0x2222222222222222222222222222222222222222",
      transaction_count: "3",
      volume_raw: "9000",
      first_seen_at: "2026-08-01 00:00:01.000",
      last_seen_at: "2026-08-30 23:59:59.000",
    }],
    "payee",
  );
  assert.equal(rows[0].identityHash.length, 64);
  assert.equal(JSON.stringify(rows).includes("0x2222222222222222222222222222222222222222"), false);
});

test("x402 SQL rows preserve integer USDC micros and disclose unadjusted identities", () => {
  const metrics = normalizeX402DailyRows([
    {
      activity_date: "2026-08-07",
      transaction_count: "12",
      transfer_count: "14",
      buyer_count: "4",
      seller_count: "6",
      volume_raw: "2500000",
    },
  ]);
  assert.equal(metrics[0].transactionCount, 12);
  assert.equal(metrics[0].volumeUsdMicros, 2_500_000);
  assert.equal(metrics[0].isAdjusted, false);
  assert.match(metrics[0].limitation, /proxy pass-through/);
});

test("x402 proxy chains count one payer payment and attribute the terminal recipient", () => {
  const addresses = ["0x1111111111111111111111111111111111111111"];
  const tokenAddress = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const multiSql = buildX402MultiLegSql({
    addresses,
    tokenAddress,
    from: new Date("2026-08-07T00:00:00.000Z"),
    to: new Date("2026-08-08T00:00:00.000Z"),
  });
  assert.match(multiSql, /HAVING count\(\) > 1/);
  assert.match(multiSql, /ORDER BY block_timestamp ASC, transaction_hash ASC, log_index ASC/);

  const hash = `0x${"a".repeat(64)}`;
  const buyer = "0x2222222222222222222222222222222222222222";
  const proxy = "0x3333333333333333333333333333333333333333";
  const merchant = "0x4444444444444444444444444444444444444444";
  const fee = "0x5555555555555555555555555555555555555555";
  const multiLegRows = [
    {
      block_timestamp: "2026-08-07 12:00:00.000",
      transaction_hash: hash,
      log_index: "1",
      from_address: buyer,
      to_address: proxy,
      amount: "100000000",
    },
    {
      block_timestamp: "2026-08-07 12:00:00.000",
      transaction_hash: hash,
      log_index: "2",
      from_address: proxy,
      to_address: merchant,
      amount: "99000000",
    },
    {
      block_timestamp: "2026-08-07 12:00:00.000",
      transaction_hash: hash,
      log_index: "3",
      from_address: proxy,
      to_address: fee,
      amount: "1000000",
    },
  ];
  const result = aggregateX402TerminalPayments({
    from: new Date("2026-08-07T00:00:00.000Z"),
    to: new Date("2026-08-08T00:00:00.000Z"),
    singleRows: [{
      activity_date: "2026-08-07",
      transaction_count: "1",
      transfer_count: "1",
      buyer_addresses: ["0x6666666666666666666666666666666666666666"],
      seller_addresses: ["0x7777777777777777777777777777777777777777"],
      volume_raw: "50000000",
    }],
    multiLegRows,
  });

  assert.equal(result.windowSummary.transactionCount, 2);
  assert.equal(result.windowSummary.volumeUsdMicros, 150_000_000);
  assert.equal(result.windowSummary.recipientVolumeUsdMicros, 149_000_000);
  assert.equal(result.windowSummary.grossVolumeUsdMicros, 250_000_000);
  assert.equal(result.windowSummary.rawTransferCount, 4);
  assert.equal(result.windowSummary.buyerCount, 2);
  assert.equal(result.windowSummary.sellerCount, 2);

  const identities = x402TerminalIdentityActivities(multiLegRows);
  assert.equal(identities.length, 2);
  assert.equal(identities.find((row) => row.role === "payer").volumeUsdMicros, 100_000_000);
  assert.equal(identities.find((row) => row.role === "payee").volumeUsdMicros, 99_000_000);
  assert.equal(JSON.stringify(identities).includes(proxy), false);
  assert.equal(JSON.stringify(identities).includes(fee), false);
});

test("daily metric ranges include explicit zero-activity days", () => {
  const metrics = fillDailyMetricRange(
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-08-04T00:00:00.000Z"),
    [{ activityDate: "2026-08-02", transactionCount: 2 }],
    { measurementUnit: "protocol_payment" },
  );
  assert.deepEqual(
    metrics.map((metric) => [metric.activityDate, metric.transactionCount]),
    [
      ["2026-08-01", 0],
      ["2026-08-02", 2],
      ["2026-08-03", 0],
    ],
  );
});

test("checked-in 30-day evidence is complete and keeps period identities separate", async () => {
  for (const protocol of ["x402", "mpp"]) {
    const path = new URL(
      `../data/backfills/${protocol}-2026-07-10_2026-08-09.json`,
      import.meta.url,
    );
    const evidence = JSON.parse(await readFile(path, "utf8"));
    assert.equal(evidence.metrics.length, 30);
    assert.equal(evidence.windowSummary.rangeStart, "2026-07-10T00:00:00.000Z");
    assert.equal(evidence.windowSummary.rangeEnd, "2026-08-09T00:00:00.000Z");
    assert.ok(evidence.windowSummary.transactionCount > 0);
    assert.ok(evidence.windowSummary.buyerCount > 0);
    assert.ok(evidence.windowSummary.sellerCount > 0);
    assert.ok(
      evidence.metrics.reduce((total, metric) => total + metric.buyerCount, 0) >=
        evidence.windowSummary.buyerCount,
      "period-wide buyers must be deduplicated independently of daily counts",
    );
    assert.ok(
      evidence.metrics.reduce((total, metric) => total + metric.sellerCount, 0) >=
        evidence.windowSummary.sellerCount,
      "period-wide recipients must be deduplicated independently of daily counts",
    );
  }
});

function tempoLog({ data, index, memo, seller }) {
  return {
    address: "0x20c000000000000000000000b9537d11c60e8b50",
    blockNumber: "0xa",
    transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    logIndex: `0x${index.toString(16)}`,
    data,
    topics: [
      "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0",
      payerTopic,
      seller,
      memo,
    ],
  };
}

function tempoSessionLog({ data, index, payer, payee }) {
  return {
    address: TEMPO_CHANNEL_RESERVE,
    blockNumber: "0xa",
    transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    logIndex: `0x${index.toString(16)}`,
    data,
    topics: [TEMPO_SETTLED_TOPIC, `0x${"c".repeat(64)}`, payer, payee],
  };
}

function abiWords(...values) {
  return `0x${values.map((value) => value.toString(16).padStart(64, "0")).join("")}`;
}
