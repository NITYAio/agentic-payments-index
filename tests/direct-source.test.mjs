import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  aggregateMppPayments,
  aggregateMppIdentityActivity,
  aggregateTempoLogs,
  aggregateX402EventPayments,
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
import {
  BASE_USDC_ADDRESS,
  collectX402BaseRpcChunk,
  createBudgetSafeRpcClient,
  decodeTransferWithAuthorizationTrace,
  ERC20_TRANSFER_TOPIC,
  transfersFromUsdcReceipt,
  x402IdentityActivitiesFromTransfers,
} from "../scripts/lib/x402-base-rpc.mjs";
import {
  blockscoutTransactionReceipt,
  blockscoutTransactionsForAddress,
  collectX402BlockscoutTransactions,
  createBudgetSafeBlockscoutClient,
} from "../scripts/lib/x402-base-blockscout.mjs";

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

test("x402 event aggregation counts terminal payments once and gates ticket-size exclusions", () => {
  const from = new Date("2026-08-18T00:00:00.000Z");
  const to = new Date("2026-08-19T00:00:00.000Z");
  const payer = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";
  const self = "0x3333333333333333333333333333333333333333";
  const result = aggregateX402EventPayments({
    from,
    to,
    payments: [
      {
        timestamp: "2026-08-18T01:00:00.000Z",
        from: payer,
        to: recipient,
        amountRaw: 2_000_000n,
        recipientAmountRaw: 1_900_000n,
        grossVolumeRaw: 3_900_000n,
        rawLegCount: 2,
      },
      {
        timestamp: "2026-08-18T02:00:00.000Z",
        from: payer,
        to: recipient,
        amountRaw: 0n,
      },
      {
        timestamp: "2026-08-18T03:00:00.000Z",
        from: self,
        to: self,
        amountRaw: 500_000n,
      },
      {
        timestamp: "2026-08-19T01:00:00.000Z",
        from: payer,
        to: recipient,
        amountRaw: 9_000_000n,
      },
    ],
  });
  assert.equal(result.windowSummary.transactionCount, 3);
  assert.equal(result.windowSummary.rawTransferCount, 4);
  assert.equal(result.windowSummary.volumeUsdMicros, 2_500_000);
  assert.equal(result.windowSummary.recipientVolumeUsdMicros, 2_400_000);
  assert.equal(result.windowSummary.grossVolumeUsdMicros, 4_400_000);
  assert.equal(result.windowSummary.buyerCount, 2);
  assert.equal(result.windowSummary.sellerCount, 2);
  assert.equal(result.windowSummary.qualifyingPaymentCount, 1);
  assert.equal(result.windowSummary.excludedZeroCount, 1);
  assert.equal(result.windowSummary.excludedSelfCount, 1);
  assert.equal(result.windowSummary.overOneCount, 1);
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

test("budget-safe Base RPC stops immediately on payment-required responses", async () => {
  let calls = 0;
  const rpc = createBudgetSafeRpcClient({
    url: "https://base.example",
    minDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return Response.json(
        { jsonrpc: "2.0", id: 1, error: { message: "Payment required for paid plan" } },
        { status: 402 },
      );
    },
  });
  await assert.rejects(
    rpc("trace_filter", [{}]),
    (error) => error.billingBlocked === true && /stopped/i.test(error.message),
  );
  assert.equal(calls, 1);
});

test("budget-safe Base RPC retries incomplete successful batch responses", async () => {
  let calls = 0;
  const rpc = createBudgetSafeRpcClient({
    url: "https://base.example",
    minDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      const entries = JSON.parse(init.body);
      const rows = entries.map((entry) => ({
        jsonrpc: "2.0",
        id: entry.id,
        result: entry.method,
      }));
      return Response.json(calls === 1 ? rows.slice(0, 1) : rows);
    },
  });
  assert.deepEqual(
    await rpc.batch([
      { method: "eth_getBlockReceipts", params: ["0x1"] },
      { method: "eth_getBlockReceipts", params: ["0x2"] },
    ]),
    ["eth_getBlockReceipts", "eth_getBlockReceipts"],
  );
  assert.equal(calls, 2);
});

test("budget-safe Blockscout client stops immediately on payment-required responses", async () => {
  let calls = 0;
  const request = createBudgetSafeBlockscoutClient({
    baseUrl: "https://base.example/api",
    minStartDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ message: "Payment required" }, { status: 402 });
    },
  });
  await assert.rejects(
    request({ module: "account", action: "txlist" }),
    (error) => error.billingBlocked === true && /stopped/i.test(error.message),
  );
  assert.equal(calls, 1);
});

test("Blockscout client retries rate-limit messages returned with HTTP 200", async () => {
  let calls = 0;
  const request = createBudgetSafeBlockscoutClient({
    baseUrl: "https://base.example/api",
    minStartDelayMs: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ status: "0", message: "Too many requests", result: null });
      }
      return Response.json({ status: "1", message: "OK", result: [] });
    },
  });
  assert.deepEqual(await request({ module: "account", action: "txlist" }), []);
  assert.equal(calls, 2);
});

test("Blockscout address collection splits full result ranges and deduplicates hashes", async () => {
  const facilitator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const row = (hash, blockNumber) => ({
    hash,
    blockNumber: String(blockNumber),
    timeStamp: "1787095800",
    from: facilitator,
    to: BASE_USDC_ADDRESS,
    input: "0xe3ee160e",
    isError: "0",
    txreceipt_status: "1",
  });
  const one = row(`0x${"1".repeat(64)}`, 10);
  const two = row(`0x${"2".repeat(64)}`, 11);
  const request = async (parameters) => {
    if (parameters.startblock === 10 && parameters.endblock === 11) return [one, two];
    if (parameters.startblock === 10) return [one];
    return [two];
  };
  const transactions = await blockscoutTransactionsForAddress({
    request,
    address: facilitator,
    startBlock: 10,
    endBlock: 11,
    pageLimit: 2,
  });
  assert.deepEqual(transactions.map((transaction) => transaction.hash), [one.hash, two.hash]);
});

test("Blockscout transaction info normalizes event logs into a receipt", async () => {
  const transactionHash = `0x${"a".repeat(64)}`;
  const receipt = await blockscoutTransactionReceipt(async (parameters) => {
    assert.deepEqual(parameters, {
      module: "transaction",
      action: "gettxinfo",
      txhash: transactionHash,
    });
    return {
      success: true,
      logs: [{
        address: BASE_USDC_ADDRESS,
        data: "0x1",
        index: "170",
        topics: [ERC20_TRANSFER_TOPIC, payerTopic, sellerOneTopic, null],
      }],
    };
  }, transactionHash);
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.transactionHash, transactionHash);
  assert.equal(receipt.logs[0].logIndex, "0xaa");
  assert.equal(receipt.logs[0].topics.length, 3);
});

test("x402 Base calldata decoder extracts payer, recipient, and USDC value", () => {
  const payer = "1111111111111111111111111111111111111111";
  const recipient = "2222222222222222222222222222222222222222";
  const word = (value) => value.padStart(64, "0");
  const input = `0xe3ee160e${word(payer)}${word(recipient)}${word("2dc6c0")}${word("0")}${word("ffffffff")}${word("a")}${word("1b")}${word("b")}${word("c")}`;
  const transfer = decodeTransferWithAuthorizationTrace(
    {
      type: "call",
      transactionHash: `0x${"a".repeat(64)}`,
      action: { input },
    },
    "2026-08-18T12:00:00.000Z",
    7,
  );
  assert.equal(transfer.from, `0x${payer}`);
  assert.equal(transfer.to, `0x${recipient}`);
  assert.equal(transfer.amountRaw, 3_000_000n);
  assert.equal(transfer.logIndex, 7);
});

test("Base receipt parser keeps only successful USDC Transfer logs", () => {
  const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transactionHash = `0x${"b".repeat(64)}`;
  const transfers = transfersFromUsdcReceipt(
    {
      status: "0x1",
      transactionHash,
      logs: [
        {
          address: BASE_USDC_ADDRESS,
          transactionHash,
          logIndex: "0x4",
          topics: [
            ERC20_TRANSFER_TOPIC,
            topic("0x1111111111111111111111111111111111111111"),
            topic("0x2222222222222222222222222222222222222222"),
          ],
          data: "0x2dc6c0",
        },
        {
          address: "0x3333333333333333333333333333333333333333",
          transactionHash,
          logIndex: "0x5",
          topics: [ERC20_TRANSFER_TOPIC, topic("0x1".padEnd(42, "1")), topic("0x2".padEnd(42, "2"))],
          data: "0x1",
        },
      ],
    },
    "2026-08-18T00:00:00.000Z",
  );
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amountRaw, 3_000_000n);
  assert.equal(transfers[0].logIndex, 4);
});

test("Base RPC chunk hashes direct and proxy-routed terminal identities", async () => {
  const facilitator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const payer = "1111111111111111111111111111111111111111";
  const recipient = "2222222222222222222222222222222222222222";
  const proxy = "0x3333333333333333333333333333333333333333";
  const merchant = "0x4444444444444444444444444444444444444444";
  const directHash = `0x${"c".repeat(64)}`;
  const proxyHash = `0x${"d".repeat(64)}`;
  const word = (value) => value.padStart(64, "0");
  const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const responses = {
    trace_filter: [
      {
        type: "call",
        transactionHash: directHash,
        action: {
          from: facilitator,
          to: BASE_USDC_ADDRESS,
          input: `0xe3ee160e${word(payer)}${word(recipient)}${word("0f4240")}${word("0")}${word("ffffffff")}${word("a")}${word("1b")}${word("b")}${word("c")}`,
        },
      },
      {
        type: "call",
        transactionHash: proxyHash,
        action: { from: facilitator, to: proxy, input: "0x12345678" },
      },
    ],
    eth_getTransactionReceipt: {
      status: "0x1",
      transactionHash: proxyHash,
      logs: [
        {
          address: BASE_USDC_ADDRESS,
          transactionHash: proxyHash,
          logIndex: "0x1",
          topics: [ERC20_TRANSFER_TOPIC, topic(`0x${payer}`), topic(proxy)],
          data: "0x1e8480",
        },
        {
          address: BASE_USDC_ADDRESS,
          transactionHash: proxyHash,
          logIndex: "0x2",
          topics: [ERC20_TRANSFER_TOPIC, topic(proxy), topic(merchant)],
          data: "0x1d4c00",
        },
      ],
    },
  };
  const result = await collectX402BaseRpcChunk({
    rpc: async (method) => responses[method],
    fromBlock: 100,
    toBlockExclusive: 120,
    facilitatorAddresses: [facilitator],
    timestamp: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(result.transactionCount, 2);
  assert.equal(result.directTransactionCount, 1);
  assert.equal(result.receiptFallbackCount, 1);
  assert.equal(result.activities.length, 3, "the repeated payer is merged within the month");
  assert.equal(result.activities.find((row) => row.role === "payer").transactionCount, 2);
  assert.equal(JSON.stringify(result.activities).includes(payer), false);
  assert.equal(JSON.stringify(result.activities).includes(proxy.slice(2)), false);
});

test("Blockscout transactions decode direct authorization and proxy terminal identities", async () => {
  const facilitator = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const payer = "1111111111111111111111111111111111111111";
  const recipient = "2222222222222222222222222222222222222222";
  const proxy = "0x3333333333333333333333333333333333333333";
  const merchant = "0x4444444444444444444444444444444444444444";
  const directHash = `0x${"5".repeat(64)}`;
  const proxyHash = `0x${"6".repeat(64)}`;
  const word = (value) => value.padStart(64, "0");
  const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const transactions = [
    {
      hash: directHash,
      blockNumber: 10,
      timestamp: "2026-08-18T00:00:00.000Z",
      from: facilitator,
      to: BASE_USDC_ADDRESS,
      input: `0xcf092995${word(payer)}${word(recipient)}${word("0f4240")}`,
      success: true,
    },
    {
      hash: proxyHash,
      blockNumber: 11,
      timestamp: "2026-08-18T00:00:02.000Z",
      from: facilitator,
      to: proxy,
      input: "0x12345678",
      success: true,
    },
  ];
  const receiptRpc = async () => ({
    status: "0x1",
    transactionHash: proxyHash,
    logs: [
      {
        address: BASE_USDC_ADDRESS,
        transactionHash: proxyHash,
        logIndex: "0x1",
        topics: [ERC20_TRANSFER_TOPIC, topic(`0x${payer}`), topic(proxy)],
        data: "0x1e8480",
      },
      {
        address: BASE_USDC_ADDRESS,
        transactionHash: proxyHash,
        logIndex: "0x2",
        topics: [ERC20_TRANSFER_TOPIC, topic(proxy), topic(merchant)],
        data: "0x1d4c00",
      },
    ],
  });
  const result = await collectX402BlockscoutTransactions({ transactions, receiptRpc });
  assert.equal(result.directTransactionCount, 1);
  assert.equal(result.receiptFallbackCount, 1);
  assert.equal(result.activities.find((row) => row.role === "payer").transactionCount, 2);
  assert.equal(JSON.stringify(result.activities).includes(payer), false);
  assert.equal(JSON.stringify(result.activities).includes(proxy.slice(2)), false);
});

test("terminal identity aggregation never writes raw Base identities", () => {
  const rawPayer = "0x1111111111111111111111111111111111111111";
  const rawPayee = "0x2222222222222222222222222222222222222222";
  const activities = x402IdentityActivitiesFromTransfers([{
    transactionHash: `0x${"e".repeat(64)}`,
    from: rawPayer,
    to: rawPayee,
    amountRaw: 1_000_000n,
    logIndex: 0,
    timestamp: "2026-08-18T00:00:00.000Z",
    activityDate: "2026-08-18",
  }]);
  assert.equal(activities.length, 2);
  assert.equal(JSON.stringify(activities).includes(rawPayer), false);
  assert.equal(JSON.stringify(activities).includes(rawPayee), false);
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
