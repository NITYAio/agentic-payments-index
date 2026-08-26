import {
  BASE_USDC_ADDRESS,
  transfersFromUsdcReceipt,
  x402IdentityActivitiesFromPayments,
} from "./x402-base-rpc.mjs";
import { aggregateX402EventPayments } from "./direct-source.mjs";

export const X402_AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const X402_SETTLED_TOPIC =
  "0x97088ec3606cfe8cc112180570d03fcde05f9b8e1bfef8e27784eaf5dd5691b6";
export const X402_SETTLED_WITH_PERMIT_TOPIC =
  "0xde5b89d10fc800c459329c382fabfcad0be0ed7e5328e01fae04e507b09ef5d8";
export const X402_CLAIMED_TOPIC =
  "0x36bd546bb573e8921fdbfd934bbed62d872796b01792cd240cce27f79dd3eddd";
export const X402_PERMIT2_PROXY = "0x402085c248eea27d92e8b30b2c58ed07f9e20001";
export const X402_BATCH_SETTLEMENT = "0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003";

function addressFromTopic(topic) {
  const value = String(topic ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) return null;
  return `0x${value.slice(-40)}`;
}

function normalizedHash(value) {
  const hash = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid Base transaction hash.");
  return hash;
}

function logIndex(log) {
  return Number.parseInt(log?.logIndex ?? "0x0", 16);
}

function terminalPayment(origin, transfers, consumed) {
  let terminal = origin;
  let rawLegCount = 1;
  let grossVolumeRaw = origin.amountRaw;
  consumed.add(origin);
  for (;;) {
    const candidates = transfers.filter(
      (row) => !consumed.has(row) && row.from === terminal.to && row.logIndex > terminal.logIndex,
    );
    if (!candidates.length) break;
    const target = terminal.amountRaw;
    const next = candidates.reduce((best, row) => {
      const bestDistance = best.amountRaw > target ? best.amountRaw - target : target - best.amountRaw;
      const rowDistance = row.amountRaw > target ? row.amountRaw - target : target - row.amountRaw;
      return rowDistance < bestDistance ? row : best;
    });
    consumed.add(next);
    terminal = next;
    rawLegCount += 1;
    grossVolumeRaw += next.amountRaw;
  }
  return terminal === origin
    ? { ...origin, recipientAmountRaw: origin.amountRaw, grossVolumeRaw, rawLegCount }
    : {
        ...origin,
        to: terminal.to,
        recipientAmountRaw: terminal.amountRaw,
        grossVolumeRaw,
        rawLegCount,
      };
}

function decodeBatchConfig(input, tokenAddress = BASE_USDC_ADDRESS) {
  const body = String(input ?? "").toLowerCase().replace(/^0x[0-9a-f]{8}/, "");
  if (body.length < 5 * 64) return null;
  const words = body.match(/.{64}/g) ?? [];
  const tokenWord = tokenAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const hits = words.flatMap((word, index) => (word === tokenWord ? [index] : []));
  if (hits.length !== 1 || hits[0] < 4) return null;
  const payer = addressFromTopic(`0x${words[hits[0] - 4]}`);
  const recipient = addressFromTopic(`0x${words[hits[0] - 2]}`);
  return payer && recipient ? { payer, recipient } : null;
}

async function logsRange(rpc, filter, fromBlock, toBlockExclusive, preferredChunk) {
  const logs = [];
  async function collect(start, endInclusive) {
    try {
      logs.push(...await rpc("eth_getLogs", [{
        ...filter,
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${endInclusive.toString(16)}`,
      }]));
    } catch (error) {
      if (start === endInclusive) {
        error.message = `${error.message} (blocks ${start}-${endInclusive}, address ${filter.address})`;
        throw error;
      }
      // Some RPC providers describe result-size or compute-unit limits as a
      // paid-plan requirement even when the same query succeeds over a smaller
      // block range. Split all range errors first; a genuine plan gate will
      // still surface deterministically at a single block.
      const middle = Math.floor((start + endInclusive) / 2);
      await collect(start, middle);
      await collect(middle + 1, endInclusive);
    }
  }
  for (let start = fromBlock; start < toBlockExclusive; start += preferredChunk) {
    await collect(start, Math.min(toBlockExclusive - 1, start + preferredChunk - 1));
  }
  return logs;
}

function groupByTransaction(logs) {
  const grouped = new Map();
  for (const log of logs) {
    const hash = normalizedHash(log.transactionHash);
    const rows = grouped.get(hash) ?? [];
    rows.push(log);
    grouped.set(hash, rows);
  }
  return grouped;
}

export async function collectX402BaseEventRange({
  rpc,
  blockRpcs = [rpc],
  fromBlock,
  toBlockExclusive,
  facilitatorRegistry,
  from,
  to,
  preferredChunk = 10_000,
  blockBatchSize = 3,
  receiptMode = "block",
  tokenAddress = BASE_USDC_ADDRESS,
  includeDistribution = false,
}) {
  const [authorizationLogs, proxyLogs, claimedLogs] = await Promise.all([
    logsRange(rpc, { address: tokenAddress, topics: [X402_AUTHORIZATION_USED_TOPIC] }, fromBlock, toBlockExclusive, preferredChunk),
    logsRange(rpc, { address: X402_PERMIT2_PROXY, topics: [[X402_SETTLED_TOPIC, X402_SETTLED_WITH_PERMIT_TOPIC]] }, fromBlock, toBlockExclusive, preferredChunk),
    logsRange(rpc, { address: X402_BATCH_SETTLEMENT, topics: [X402_CLAIMED_TOPIC] }, fromBlock, toBlockExclusive, preferredChunk),
  ]);
  const grouped = groupByTransaction([...authorizationLogs, ...proxyLogs, ...claimedLogs]);
  const payments = [];
  let filteredTransactions = 0;
  let unresolvedBatchClaims = 0;
  let rawLegCount = 0;

  function processTransaction(transactionHash, signalLogs, transaction, receipt, timestamp) {
    if (!transaction || !receipt || receipt.status !== "0x1") return;
    const transactionDate = timestamp.slice(0, 10);
    const activeFacilitators = new Set(
      facilitatorRegistry
        .filter((entry) => entry.firstSeen <= transactionDate)
        .map((entry) => entry.address.toLowerCase()),
    );
    const allTransfers = transfersFromUsdcReceipt(receipt, timestamp, tokenAddress);
    rawLegCount += allTransfers.length;
    const auth = signalLogs
      .filter((log) => String(log.address).toLowerCase() === tokenAddress.toLowerCase())
      .sort((left, right) => logIndex(left) - logIndex(right));
    if (auth.length) {
      if (!activeFacilitators.has(String(transaction.from).toLowerCase())) {
        filteredTransactions += 1;
        return;
      }
      const consumed = new Set();
      for (const event of auth) {
        const payer = addressFromTopic(event.topics?.[1]);
        const origin = allTransfers
          .filter((row) => !consumed.has(row) && row.from === payer && row.logIndex > logIndex(event))
          .sort((left, right) => left.logIndex - right.logIndex)[0];
        if (origin) payments.push(terminalPayment(origin, allTransfers, consumed));
      }
      return;
    }

    const proxy = signalLogs
      .filter((log) => String(log.address).toLowerCase() === X402_PERMIT2_PROXY)
      .sort((left, right) => logIndex(left) - logIndex(right));
    if (proxy.length) {
      const consumed = new Set();
      proxy.forEach((event, index) => {
        const origin = allTransfers.filter((row) => !consumed.has(row))[index];
        if (origin) payments.push(terminalPayment(origin, allTransfers, consumed));
      });
    }

    const claims = signalLogs
      .filter((log) => String(log.address).toLowerCase() === X402_BATCH_SETTLEMENT)
      .sort((left, right) => logIndex(left) - logIndex(right));
    if (claims.length) {
      const config = decodeBatchConfig(transaction.input, tokenAddress);
      if (!config) unresolvedBatchClaims += claims.length;
      else {
        for (const claim of claims) {
          const amountRaw = BigInt(`0x${String(claim.data ?? "0x0").replace(/^0x/, "").slice(0, 64) || "0"}`);
          payments.push({
            transactionHash,
            from: config.payer,
            to: config.recipient,
            amountRaw,
            recipientAmountRaw: amountRaw,
            grossVolumeRaw: amountRaw,
            rawLegCount: 1,
            logIndex: logIndex(claim),
            timestamp,
            activityDate: transactionDate,
          });
        }
      }
    }
  }

  const byBlock = new Map();
  for (const [transactionHash, signalLogs] of grouped) {
    const blockNumberHex = signalLogs[0]?.blockNumber;
    if (!blockNumberHex) continue;
    const rows = byBlock.get(blockNumberHex) ?? [];
    rows.push([transactionHash, signalLogs]);
    byBlock.set(blockNumberHex, rows);
  }
  const blockJobs = [...byBlock.entries()];

  async function timestampForSignals(signalLogs, receipt) {
    const blockTimestamp = signalLogs.find((log) => log.blockTimestamp)?.blockTimestamp;
    if (blockTimestamp) {
      return new Date(Number.parseInt(blockTimestamp, 16) * 1_000).toISOString();
    }
    const blockNumberHex = signalLogs[0]?.blockNumber ?? receipt?.blockNumber;
    // Timestamp lookups use the log provider rather than the receipt provider.
    // This keeps QuickNode's small request budget focused on the receipt data
    // that the public log provider cannot supply reliably.
    const block = await rpc("eth_getBlockByNumber", [blockNumberHex, false]);
    if (!block?.timestamp) throw new Error(`Base block ${blockNumberHex} has no timestamp.`);
    return new Date(Number.parseInt(block.timestamp, 16) * 1_000).toISOString();
  }

  if (receiptMode === "transaction") {
    const transactionJobs = [...grouped.entries()];
    let nextTransaction = 0;
    let completedTransactions = 0;
    async function transactionWorker(workerIndex) {
      const blockRpc = blockRpcs[workerIndex % blockRpcs.length];
      while (nextTransaction < transactionJobs.length) {
        const index = nextTransaction;
        const batch = transactionJobs.slice(index, index + blockBatchSize);
        nextTransaction += batch.length;
        const results = await blockRpc.batch(batch.map(([transactionHash]) => ({
          method: "eth_getTransactionReceipt",
          params: [transactionHash],
        })));
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const [transactionHash, signalLogs] = batch[batchIndex];
          const receipt = results[batchIndex];
          if (!receipt) throw new Error(`Base receipt ${transactionHash} was not found.`);
          const timestamp = await timestampForSignals(signalLogs, receipt);
          let transaction = { from: receipt.from, input: "0x" };
          if (
            signalLogs.some((log) =>
              String(log.address).toLowerCase() === X402_BATCH_SETTLEMENT,
            )
          ) {
            transaction = await blockRpc("eth_getTransactionByHash", [transactionHash]);
          }
          processTransaction(transactionHash, signalLogs, transaction, receipt, timestamp);
        }
        completedTransactions += batch.length;
        if (
          completedTransactions % 500 < batch.length ||
          completedTransactions === transactionJobs.length
        ) {
          process.stderr.write(
            `Resolved x402 event transactions ${completedTransactions}/${transactionJobs.length}; ` +
              `${payments.length.toLocaleString()} terminal payments\n`,
          );
        }
      }
    }
    await Promise.all(blockRpcs.map((_, index) => transactionWorker(index)));
  } else if (receiptMode === "block") {
    let nextBlock = 0;
    let completedBlocks = 0;
    async function blockWorker(workerIndex) {
      const blockRpc = blockRpcs[workerIndex % blockRpcs.length];
      while (nextBlock < blockJobs.length) {
        const index = nextBlock;
        const batch = blockJobs.slice(index, index + blockBatchSize);
        nextBlock += batch.length;
      // Base log responses include blockTimestamp. That lets us resolve the
      // active payment transactions from receipts alone instead of downloading
      // every full block and every transaction in it. The free dRPC tier permits
      // three JSON-RPC entries per HTTP batch, so one receipt call per block also
      // makes blockBatchSize=3 efficient and provider-compatible.
      const calls = batch.map(([blockNumberHex]) => ({
        method: "eth_getBlockReceipts",
        params: [blockNumberHex],
      }));
      const results = typeof blockRpc.batch === "function"
        ? await blockRpc.batch(calls)
        : await Promise.all(calls.map(({ method, params }) => blockRpc(method, params)));
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const [blockNumberHex, transactionsWithSignals] = batch[batchIndex];
        const receipts = results[batchIndex];
        if (!Array.isArray(receipts)) {
          throw new Error(`Base block bundle ${blockNumberHex} was incomplete.`);
        }
        const receiptMap = new Map(
          receipts.map((receipt) => [String(receipt.transactionHash).toLowerCase(), receipt]),
        );
        for (const [transactionHash, signalLogs] of transactionsWithSignals) {
          const receipt = receiptMap.get(transactionHash);
          const timestamp = await timestampForSignals(signalLogs, receipt);
          let transaction = receipt ? { from: receipt.from, input: "0x" } : null;
          if (
            signalLogs.some((log) =>
              String(log.address).toLowerCase() === X402_BATCH_SETTLEMENT,
            )
          ) {
            transaction = await blockRpc("eth_getTransactionByHash", [transactionHash]);
          }
          processTransaction(
            transactionHash,
            signalLogs,
            transaction,
            receipt,
            timestamp,
          );
        }
      }
        completedBlocks += batch.length;
        if (completedBlocks % 500 < batch.length || completedBlocks === blockJobs.length) {
          process.stderr.write(
            `Resolved x402 event blocks ${completedBlocks}/${blockJobs.length}; ` +
              `${payments.length.toLocaleString()} terminal payments\n`,
          );
        }
      }
    }
    await Promise.all(blockRpcs.map((_, index) => blockWorker(index)));
  } else if (receiptMode === "block-transactions") {
    // AuthorizationUsed is emitted for ordinary USDC authorizations as well as
    // x402 payments. Reading the full transaction list for each signal-bearing
    // block lets us filter by facilitator sender before requesting receipts.
    // This turns hundreds of receipt lookups into only the handful of receipts
    // that can actually be x402 payments.
    let nextBlock = 0;
    let completedBlocks = 0;
    async function blockTransactionWorker(workerIndex) {
      const blockRpc = blockRpcs[workerIndex % blockRpcs.length];
      while (nextBlock < blockJobs.length) {
        const index = nextBlock;
        const batch = blockJobs.slice(index, index + blockBatchSize);
        nextBlock += batch.length;
        const blocks = await blockRpc.batch(batch.map(([blockNumberHex]) => ({
          method: "eth_getBlockByNumber",
          params: [blockNumberHex, true],
        })));
        const candidates = [];
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const [blockNumberHex, transactionsWithSignals] = batch[batchIndex];
          const block = blocks[batchIndex];
          if (!block || !Array.isArray(block.transactions) || !block.timestamp) {
            throw new Error(`Base transaction block ${blockNumberHex} was incomplete.`);
          }
          const timestamp = new Date(Number.parseInt(block.timestamp, 16) * 1_000).toISOString();
          const transactionDate = timestamp.slice(0, 10);
          const activeFacilitators = new Set(
            facilitatorRegistry
              .filter((entry) => entry.firstSeen <= transactionDate)
              .map((entry) => entry.address.toLowerCase()),
          );
          const transactionMap = new Map(
            block.transactions.map((transaction) => [
              String(transaction.hash ?? "").toLowerCase(),
              transaction,
            ]),
          );
          for (const [transactionHash, signalLogs] of transactionsWithSignals) {
            const transaction = transactionMap.get(transactionHash);
            if (!transaction) {
              throw new Error(`Base transaction ${transactionHash} was absent from ${blockNumberHex}.`);
            }
            const hasAuthorization = signalLogs.some(
              (log) => String(log.address).toLowerCase() === tokenAddress.toLowerCase(),
            );
            if (
              hasAuthorization &&
              !activeFacilitators.has(String(transaction.from ?? "").toLowerCase())
            ) {
              filteredTransactions += 1;
              continue;
            }
            candidates.push({ transactionHash, signalLogs, transaction, timestamp });
          }
        }
        if (candidates.length) {
          const receipts = await blockRpc.batch(candidates.map(({ transactionHash }) => ({
            method: "eth_getTransactionReceipt",
            params: [transactionHash],
          })));
          for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            const candidate = candidates[candidateIndex];
            const receipt = receipts[candidateIndex];
            if (!receipt) throw new Error(`Base receipt ${candidate.transactionHash} was not found.`);
            processTransaction(
              candidate.transactionHash,
              candidate.signalLogs,
              candidate.transaction,
              receipt,
              candidate.timestamp,
            );
          }
        }
        completedBlocks += batch.length;
        if (completedBlocks % 500 < batch.length || completedBlocks === blockJobs.length) {
          process.stderr.write(
            `Resolved x402 signal blocks ${completedBlocks}/${blockJobs.length}; ` +
              `${payments.length.toLocaleString()} terminal payments\n`,
          );
        }
      }
    }
    await Promise.all(blockRpcs.map((_, index) => blockTransactionWorker(index)));
  } else if (receiptMode === "transaction-filter") {
    // AuthorizationUsed is a common USDC event and most matching logs are not
    // x402 payments. Resolve only each transaction's lightweight envelope
    // first, filter by the known facilitator sender, and request receipts only
    // for the small surviving set. This follows the provider-recommended
    // eth_getLogs + sender-resolution path without trace_filter or full blocks.
    const transactionJobs = [...grouped.entries()];
    let nextTransaction = 0;
    let completedTransactions = 0;
    async function transactionFilterWorker(workerIndex) {
      const blockRpc = blockRpcs[workerIndex % blockRpcs.length];
      while (nextTransaction < transactionJobs.length) {
        const index = nextTransaction;
        const batch = transactionJobs.slice(index, index + blockBatchSize);
        nextTransaction += batch.length;
        const transactions = await blockRpc.batch(batch.map(([transactionHash]) => ({
          method: "eth_getTransactionByHash",
          params: [transactionHash],
        })));
        const candidates = [];
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const [transactionHash, signalLogs] = batch[batchIndex];
          const transaction = transactions[batchIndex];
          if (!transaction) throw new Error(`Base transaction ${transactionHash} was not found.`);
          const hasAuthorization = signalLogs.some(
            (log) => String(log.address).toLowerCase() === tokenAddress.toLowerCase(),
          );
          if (hasAuthorization) {
            // The backfill slices never cross a UTC day, so the slice start is
            // sufficient for the date-granular facilitator activation test.
            // The exact block timestamp is still resolved for retained rows.
            const transactionDate = from
              ? new Date(from).toISOString().slice(0, 10)
              : (await timestampForSignals(signalLogs)).slice(0, 10);
            const activeFacilitators = new Set(
              facilitatorRegistry
                .filter((entry) => entry.firstSeen <= transactionDate)
                .map((entry) => entry.address.toLowerCase()),
            );
            if (!activeFacilitators.has(String(transaction.from ?? "").toLowerCase())) {
              filteredTransactions += 1;
              continue;
            }
          }
          candidates.push({ transactionHash, signalLogs, transaction });
        }
        if (candidates.length) {
          const receipts = await blockRpc.batch(candidates.map(({ transactionHash }) => ({
            method: "eth_getTransactionReceipt",
            params: [transactionHash],
          })));
          for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
            const candidate = candidates[candidateIndex];
            const receipt = receipts[candidateIndex];
            if (!receipt) throw new Error(`Base receipt ${candidate.transactionHash} was not found.`);
            const timestamp = await timestampForSignals(candidate.signalLogs, receipt);
            processTransaction(
              candidate.transactionHash,
              candidate.signalLogs,
              candidate.transaction,
              receipt,
              timestamp,
            );
          }
        }
        completedTransactions += batch.length;
        if (
          completedTransactions % 500 < batch.length ||
          completedTransactions === transactionJobs.length
        ) {
          process.stderr.write(
            `Filtered x402 signal transactions ${completedTransactions}/${transactionJobs.length}; ` +
              `${payments.length.toLocaleString()} terminal payments\n`,
          );
        }
      }
    }
    await Promise.all(blockRpcs.map((_, index) => transactionFilterWorker(index)));
  } else {
    throw new Error(`Unsupported x402 receipt mode: ${receiptMode}.`);
  }

  const aggregate = from && to
    ? aggregateX402EventPayments({ payments, from, to, includeDistribution })
    : null;

  return {
    signalLogCount: authorizationLogs.length + proxyLogs.length + claimedLogs.length,
    authorizationLogCount: authorizationLogs.length,
    proxyLogCount: proxyLogs.length,
    claimedLogCount: claimedLogs.length,
    transactionCount: grouped.size,
    activeBlockCount: blockJobs.length,
    blockBatchSize,
    receiptMode,
    filteredTransactions,
    unresolvedBatchClaims,
    rawLegCount,
    paymentCount: payments.length,
    activities: x402IdentityActivitiesFromPayments(payments),
    metrics: aggregate?.metrics,
    windowSummary: aggregate?.windowSummary,
  };
}

export const __test = { decodeBatchConfig, terminalPayment };
