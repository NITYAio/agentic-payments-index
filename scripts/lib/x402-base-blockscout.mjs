import { collapseX402TransferChains } from "./direct-source.mjs";
import {
  BASE_USDC_ADDRESS,
  decodeX402AuthorizationInput,
  transfersFromUsdcReceipt,
  x402IdentityActivitiesFromPayments,
} from "./x402-base-rpc.mjs";

const DEFAULT_BASE_URL = "https://base.blockscout.com/api";
const DEFAULT_PAGE_LIMIT = 10_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isBillingResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return status === 402 || /payment required|paid plan|insufficient (credit|balance)/i.test(text);
}

export function createBudgetSafeBlockscoutClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  minStartDelayMs = 750,
  maxAttempts = 7,
  timeoutMs = 60_000,
  sleepImpl = sleep,
}) {
  let nextStartAt = 0;
  let startQueue = Promise.resolve();

  async function reserveStart() {
    const reservation = startQueue.then(async () => {
      const wait = Math.max(0, nextStartAt - Date.now());
      if (wait > 0) await sleepImpl(wait);
      nextStartAt = Date.now() + minStartDelayMs;
    });
    startQueue = reservation.catch(() => undefined);
    await reservation;
  }

  return async function request(parameters) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await reserveStart();
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": "AgenticPaymentsIndex/0.3" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        if (attempt === maxAttempts - 1) {
          throw new Error("Base Blockscout request failed after retries.", { cause });
        }
        await sleepImpl(500 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      if (isBillingResponse(response.status, body)) {
        const error = new Error(
          "Base Blockscout requested paid access. Collection stopped without changing plans.",
        );
        error.billingBlocked = true;
        throw error;
      }
      if (response.ok && body && typeof body === "object") {
        if (body.status === "0" && /no transactions found/i.test(body.message ?? body.result ?? "")) {
          return [];
        }
        if (body.status === "1") return body.result;
      }
      const bodyRateLimited =
        body && typeof body === "object" && /too many requests|rate limit/i.test(
          `${body.message ?? ""} ${body.result ?? ""}`,
        );
      const retryable =
        bodyRateLimited || response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts - 1) {
        const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
        throw new Error(`Base Blockscout request failed (${response.status}): ${detail}`);
      }
      const retryAfterSeconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
      await sleepImpl(
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 500 * 2 ** attempt,
      );
    }
    throw new Error("Base Blockscout request exhausted its retry budget.");
  };
}

export async function blockscoutBlockForTime(request, date, closest = "after") {
  const timestamp = Math.floor(new Date(date).getTime() / 1_000);
  if (!Number.isSafeInteger(timestamp)) throw new Error("A valid block lookup date is required.");
  const result = await request({
    module: "block",
    action: "getblocknobytime",
    timestamp,
    closest,
  });
  const blockNumber = Number.parseInt(result?.blockNumber ?? result, 10);
  if (!Number.isSafeInteger(blockNumber)) throw new Error("Blockscout returned an invalid block number.");
  return blockNumber;
}

function normalizeTransaction(row) {
  return {
    hash: String(row.hash ?? "").toLowerCase(),
    blockNumber: Number.parseInt(row.blockNumber, 10),
    timestamp: new Date(Number.parseInt(row.timeStamp, 10) * 1_000).toISOString(),
    from: String(row.from ?? "").toLowerCase(),
    to: String(row.to ?? "").toLowerCase(),
    input: String(row.input ?? "0x").toLowerCase(),
    success: row.isError === "0" && row.txreceipt_status !== "0",
  };
}

async function transactionsInRange(request, address, startBlock, endBlock, pageLimit) {
  const result = await request({
    module: "account",
    action: "txlist",
    address,
    startblock: startBlock,
    endblock: endBlock,
    page: 1,
    offset: pageLimit,
    sort: "asc",
  });
  const rows = Array.isArray(result) ? result : [];
  if (rows.length < pageLimit) return rows;
  if (startBlock < endBlock) {
    const middle = Math.floor((startBlock + endBlock) / 2);
    const [left, right] = await Promise.all([
      transactionsInRange(request, address, startBlock, middle, pageLimit),
      transactionsInRange(request, address, middle + 1, endBlock, pageLimit),
    ]);
    return [...left, ...right];
  }
  const pages = [rows];
  for (let page = 2; ; page += 1) {
    const next = await request({
      module: "account",
      action: "txlist",
      address,
      startblock: startBlock,
      endblock: endBlock,
      page,
      offset: pageLimit,
      sort: "asc",
    });
    const nextRows = Array.isArray(next) ? next : [];
    pages.push(nextRows);
    if (nextRows.length < pageLimit) break;
  }
  return pages.flat();
}

export async function blockscoutTransactionsForAddress({
  request,
  address,
  startBlock,
  endBlock,
  pageLimit = DEFAULT_PAGE_LIMIT,
}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid facilitator address.");
  if (!Number.isSafeInteger(startBlock) || !Number.isSafeInteger(endBlock) || endBlock < startBlock) {
    throw new Error("Invalid Blockscout transaction block range.");
  }
  const rows = await transactionsInRange(
    request,
    address.toLowerCase(),
    startBlock,
    endBlock,
    pageLimit,
  );
  const deduplicated = new Map();
  for (const row of rows) {
    const transaction = normalizeTransaction(row);
    if (transaction.from === address.toLowerCase() && transaction.success) {
      deduplicated.set(transaction.hash, transaction);
    }
  }
  return [...deduplicated.values()].sort((left, right) =>
    left.blockNumber - right.blockNumber || left.hash.localeCompare(right.hash),
  );
}

export async function blockscoutTransactionReceipt(request, transactionHash) {
  const hash = String(transactionHash ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid Blockscout transaction hash.");
  const result = await request({
    module: "transaction",
    action: "gettxinfo",
    txhash: hash,
  });
  if (!result || typeof result !== "object") return null;
  return {
    status: result.success === false ? "0x0" : "0x1",
    transactionHash: hash,
    logs: (Array.isArray(result.logs) ? result.logs : []).map((log) => ({
      address: log.address,
      data: log.data,
      topics: (Array.isArray(log.topics) ? log.topics : []).filter(Boolean),
      transactionHash: hash,
      logIndex: `0x${Number.parseInt(log.index ?? log.logIndex ?? "0", 10).toString(16)}`,
    })),
  };
}

export async function collectX402BlockscoutTransactions({
  transactions,
  receiptLoader,
  receiptRpc,
  tokenAddress = BASE_USDC_ADDRESS,
}) {
  const loadReceipt = receiptLoader ?? (
    receiptRpc ? (transactionHash) => receiptRpc("eth_getTransactionReceipt", [transactionHash]) : null
  );
  const transfers = [];
  let directTransactionCount = 0;
  let receiptFallbackCount = 0;
  let ignoredTransactionCount = 0;
  for (const transaction of transactions) {
    if (transaction.to === tokenAddress.toLowerCase()) {
      const decoded = decodeX402AuthorizationInput({
        input: transaction.input,
        transactionHash: transaction.hash,
        timestamp: transaction.timestamp,
      });
      if (decoded) {
        transfers.push(decoded);
        directTransactionCount += 1;
      } else ignoredTransactionCount += 1;
      continue;
    }
    if (!loadReceipt) throw new Error("A receipt loader is required for proxy-routed x402 transactions.");
    const receipt = await loadReceipt(transaction.hash);
    const receiptTransfers = transfersFromUsdcReceipt(receipt, transaction.timestamp, tokenAddress);
    if (receiptTransfers.length) {
      transfers.push(...receiptTransfers);
      receiptFallbackCount += 1;
    } else ignoredTransactionCount += 1;
  }
  const payments = collapseX402TransferChains(transfers);
  return {
    transactionCount: transactions.length,
    directTransactionCount,
    receiptFallbackCount,
    ignoredTransactionCount,
    transferCount: transfers.length,
    paymentCount: payments.length,
    payments,
    activities: x402IdentityActivitiesFromPayments(payments),
  };
}
