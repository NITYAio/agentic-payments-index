import { DataSourceBuilder } from "@subsquid/evm-stream";

import { collectX402BlockscoutTransactions } from "./x402-base-blockscout.mjs";
import { createX402EventPaymentAccumulator } from "./direct-source.mjs";
import {
  X402_AUTHORIZATION_USED_TOPIC,
  X402_BATCH_SETTLEMENT,
  X402_CLAIMED_TOPIC,
  X402_PERMIT2_PROXY,
  X402_SETTLED_TOPIC,
  X402_SETTLED_WITH_PERMIT_TOPIC,
} from "./x402-base-events.mjs";
import {
  BASE_USDC_ADDRESS,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
} from "./x402-base-rpc.mjs";

export const DEFAULT_BASE_SQD_PORTAL = "https://portal.sqd.dev/datasets/base-mainnet";

function normalizedAddress(value) {
  const address = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error("Invalid x402 facilitator address.");
  return address;
}

function hexQuantity(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid EVM quantity.");
  return `0x${value.toString(16)}`;
}

function receiptFromPortal(transaction, logs) {
  return {
    transactionHash: transaction.hash,
    status: transaction.success ? "0x1" : "0x0",
    logs: logs.map((log) => ({
      address: String(log.address ?? "").toLowerCase(),
      data: String(log.data ?? "0x").toLowerCase(),
      topics: (Array.isArray(log.topics) ? log.topics : []).map((topic) =>
        String(topic).toLowerCase(),
      ),
      transactionHash: transaction.hash,
      logIndex: hexQuantity(log.logIndex),
    })),
  };
}

export async function collectX402BaseSqdRange({
  portal = DEFAULT_BASE_SQD_PORTAL,
  fromBlock,
  toBlockExclusive,
  facilitatorRegistry,
  tokenAddress = BASE_USDC_ADDRESS,
  from,
  to,
  onProgress,
}) {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlockExclusive) ||
    toBlockExclusive <= fromBlock
  ) {
    throw new Error("A valid Base block range is required for SQD collection.");
  }
  if (!Array.isArray(facilitatorRegistry) || facilitatorRegistry.length === 0) {
    throw new Error("A non-empty x402 facilitator registry is required.");
  }
  if (!(from instanceof Date) || !(to instanceof Date) || to <= from) {
    throw new Error("A valid x402 SQD aggregation range is required.");
  }

  const firstSeenByAddress = new Map(
    facilitatorRegistry.map((entry) => [
      normalizedAddress(entry.address),
      new Date(`${entry.firstSeen}T00:00:00.000Z`).getTime(),
    ]),
  );
  const facilitatorAddresses = [...firstSeenByAddress.keys()];
  const source = new DataSourceBuilder()
    .setPortal(portal)
    .setBlockRange({ from: fromBlock, to: toBlockExclusive - 1 })
    .setFields({
      block: { timestamp: true },
      transaction: {
        hash: true,
        from: true,
        to: true,
        input: true,
        status: true,
      },
      log: {
        address: true,
        data: true,
        topics: true,
        transactionHash: true,
      },
    })
    // Fetch direct authorization calls by method signature and fetch
    // AuthorizationUsed logs separately. The latter keeps intermediary
    // contract settlements without downloading every transaction originated
    // by a high-volume facilitator address.
    .addTransaction({
      where: {
        from: facilitatorAddresses,
        sighash: [TRANSFER_WITH_AUTHORIZATION_SELECTOR, RECEIVE_WITH_AUTHORIZATION_SELECTOR],
      },
      include: {
        logs: true,
      },
    })
    .addLog({
      where: {
        address: [tokenAddress],
        topic0: [X402_AUTHORIZATION_USED_TOPIC],
      },
      include: {
        transaction: true,
        transactionLogs: true,
      },
    })
    .addLog({
      where: {
        address: [X402_PERMIT2_PROXY],
        topic0: [X402_SETTLED_TOPIC, X402_SETTLED_WITH_PERMIT_TOPIC],
      },
      include: {
        transaction: true,
        transactionLogs: true,
      },
    })
    .addLog({
      where: {
        address: [X402_BATCH_SETTLEMENT],
        topic0: [X402_CLAIMED_TOPIC],
      },
      include: {
        transaction: true,
        transactionLogs: true,
      },
    })
    .build();

  const aggregation = createX402EventPaymentAccumulator({
    from,
    to,
    includeDistribution: true,
  });
  const activities = new Map();
  const counters = {
    transactionCount: 0,
    directTransactionCount: 0,
    receiptFallbackCount: 0,
    ignoredTransactionCount: 0,
    transferCount: 0,
    paymentCount: 0,
  };
  const mergeActivities = (rows) => {
    for (const row of rows) {
      const key = [
        row.role,
        row.identityScheme,
        row.identityHash,
        row.activityMonth,
        row.evidenceLevel,
      ].join("|");
      const current = activities.get(key);
      if (current) {
        current.transactionCount += row.transactionCount;
        current.volumeUsdMicros += row.volumeUsdMicros;
        if (row.firstSeenAt < current.firstSeenAt) current.firstSeenAt = row.firstSeenAt;
        if (row.lastSeenAt > current.lastSeenAt) current.lastSeenAt = row.lastSeenAt;
      } else activities.set(key, { ...row });
    }
  };
  let batches = 0;
  let matchedBlocks = 0;
  let processedTransactions = 0;
  let lastBlock = fromBlock - 1;
  for await (const batch of source.getStream({ from: fromBlock, to: toBlockExclusive - 1 })) {
    batches += 1;
    matchedBlocks += batch.blocks.length;
    const transactions = [];
    const receipts = new Map();
    for (const block of batch.blocks) {
      lastBlock = Math.max(lastBlock, block.header.number);
      const timestamp = new Date(block.header.timestamp).toISOString();
      const logsByTransaction = new Map();
      for (const log of block.logs) {
        const logs = logsByTransaction.get(log.transactionIndex) ?? [];
        logs.push(log);
        logsByTransaction.set(log.transactionIndex, logs);
      }
      for (const raw of block.transactions) {
        const fromAddress = normalizedAddress(raw.from);
        const firstSeen = firstSeenByAddress.get(fromAddress);
        const transactionLogs = logsByTransaction.get(raw.transactionIndex) ?? [];
        const toAddress = String(raw.to ?? "").toLowerCase();
        const input = String(raw.input ?? "0x").toLowerCase();
        const isDirectAuthorization =
          toAddress === tokenAddress.toLowerCase() &&
          [TRANSFER_WITH_AUTHORIZATION_SELECTOR, RECEIVE_WITH_AUTHORIZATION_SELECTOR].some(
            (selector) => input.startsWith(selector),
          );
        const hasUsdcAuthorizationSignal = transactionLogs.some((log) => {
          const address = String(log.address ?? "").toLowerCase();
          const topic0 = String(log.topics?.[0] ?? "").toLowerCase();
          return (
            address === tokenAddress.toLowerCase() &&
            topic0 === X402_AUTHORIZATION_USED_TOPIC
          );
        });
        const hasProtocolSettlementSignal = transactionLogs.some((log) => {
          const address = String(log.address ?? "").toLowerCase();
          const topic0 = String(log.topics?.[0] ?? "").toLowerCase();
          return (
            (address === X402_PERMIT2_PROXY &&
              new Set([X402_SETTLED_TOPIC, X402_SETTLED_WITH_PERMIT_TOPIC]).has(topic0)) ||
            (address === X402_BATCH_SETTLEMENT && topic0 === X402_CLAIMED_TOPIC)
          );
        });
        if (
          raw.status !== 1 ||
          (!hasProtocolSettlementSignal &&
            (firstSeen === undefined ||
              new Date(timestamp).getTime() < firstSeen ||
              (!isDirectAuthorization && !hasUsdcAuthorizationSignal)))
        ) {
          continue;
        }
        const transaction = {
          hash: String(raw.hash ?? "").toLowerCase(),
          blockNumber: block.header.number,
          timestamp,
          from: fromAddress,
          to: toAddress,
          input,
          success: true,
        };
        transactions.push(transaction);
        receipts.set(
          transaction.hash,
          receiptFromPortal(transaction, transactionLogs),
        );
      }
    }
    const result = await collectX402BlockscoutTransactions({
      transactions,
      receiptLoader: (transactionHash) => receipts.get(transactionHash),
      tokenAddress,
    });
    aggregation.add(result.payments);
    mergeActivities(result.activities);
    for (const field of Object.keys(counters)) counters[field] += result[field];
    processedTransactions += transactions.length;
    onProgress?.({
      batches,
      matchedBlocks,
      transactions: processedTransactions,
      lastBlock,
    });
  }

  return {
    portalBatches: batches,
    matchedBlocks,
    fromBlock,
    toBlockExclusive,
    ...counters,
    ...aggregation.finish(),
    activities: [...activities.values()].sort((left, right) =>
      [left.activityMonth, left.role, left.identityScheme, left.identityHash]
        .join("|")
        .localeCompare(
          [right.activityMonth, right.role, right.identityScheme, right.identityHash].join("|"),
        ),
    ),
  };
}
