import { collapseX402TransferChains, sha256Hex } from "./direct-source.mjs";

export const BASE_CHAIN_ID = 8_453;
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const RECEIVE_WITH_AUTHORIZATION_SELECTOR = "0xcf092995";
export const X402_AUTHORIZATION_SELECTORS = new Set([
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rpcErrorMessage(method, status, body) {
  const detail = typeof body === "string"
    ? body.slice(0, 300)
    : body?.error?.message ?? "unknown error";
  return `Base JSON-RPC ${method} failed (${status}): ${detail}`;
}

function isBillingResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return status === 402 || /payment required|insufficient (credit|balance)/i.test(text);
}

function isRetryableRpcError(status, body) {
  if (status === 408 || status === 429 || status >= 500) return true;
  const text = typeof body === "string" ? body : body?.error?.message ?? "";
  return /rate.?limit|request limit reached|too many requests|throughput|compute units?|request timeout|timed? out|temporar(?:y|ily)|try again/i.test(text);
}

function networkCauseLabel(cause) {
  const nested = cause?.cause;
  const code = nested?.code ?? cause?.code;
  const name = nested?.name ?? cause?.name;
  return [name, code].filter(Boolean).join("/") || "unknown";
}

export function createBudgetSafeRpcClient({
  url,
  fetchImpl = fetch,
  minDelayMs = 150,
  maxAttempts = 4,
  timeoutMs = 30_000,
  sleepImpl = sleep,
}) {
  if (!url) throw new Error("A Base JSON-RPC URL is required.");
  let id = 0;
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  async function reserveRequestUnits(units = 1) {
    const now = Date.now();
    const waitForSlot = Math.max(0, nextRequestAt - now);
    if (waitForSlot > 0) await sleepImpl(waitForSlot);
    const startedAt = Date.now();
    // Providers such as QuickNode count every JSON-RPC entry inside an HTTP
    // batch against the per-second allowance. Reserve time for every entry,
    // not just for the outer HTTP request, so batching cannot accidentally
    // burst through a free-plan limit.
    nextRequestAt = Math.max(startedAt, nextRequestAt) + minDelayMs * units;
  }

  function request(method, params) {
    const requestId = ++id;
    const run = queue.then(async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await reserveRequestUnits(1);
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          if (attempt === maxAttempts - 1) {
            const error = new Error(
              `Base JSON-RPC ${method} network request failed after ${maxAttempts} attempts ` +
                `(${networkCauseLabel(cause)}).`,
              { cause },
            );
            error.splittable = method === "trace_filter";
            throw error;
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
            `Base RPC ${method} requested paid access. Collection stopped before retrying or changing plans.`,
          );
          error.billingBlocked = true;
          throw error;
        }
        if (response.ok && body && typeof body === "object" && !body.error) {
          return body.result;
        }
        const retryable = isRetryableRpcError(response.status, body);
        if (!retryable || attempt === maxAttempts - 1) {
          const error = new Error(rpcErrorMessage(method, response.status, body));
          error.splittable = method === "trace_filter";
          throw error;
        }
        const retryAfterSeconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
        const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0;
        await sleepImpl(Math.max(retryAfterMs, 500 * 2 ** attempt));
      }
      throw new Error(`Base JSON-RPC ${method} exhausted its retry budget.`);
    });
    queue = run.catch(() => undefined);
    return run;
  }

  request.batch = function batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0) {
      return Promise.resolve([]);
    }
    const entries = calls.map(({ method, params = [] }) => ({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params,
    }));
    const ids = new Map(entries.map((entry, index) => [entry.id, index]));
    const run = queue.then(async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        await reserveRequestUnits(entries.length);
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entries),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          if (attempt === maxAttempts - 1) {
            throw new Error(
              `Base JSON-RPC batch network request failed after ${maxAttempts} attempts ` +
                `(${networkCauseLabel(cause)}).`,
              { cause },
            );
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
          const error = new Error("Base RPC batch requested paid access. Collection stopped.");
          error.billingBlocked = true;
          throw error;
        }
        const rows = Array.isArray(body) ? body : [];
        const failed = rows.find((row) => row?.error);
        const incomplete = rows.length !== entries.length || rows.some((row) => !ids.has(row?.id));
        const retryable = incomplete || isRetryableRpcError(response.status, failed ?? body);
        if (response.ok && rows.length === entries.length && !failed) {
          const ordered = Array(entries.length);
          for (const row of rows) ordered[ids.get(row.id)] = row.result;
          return ordered;
        }
        if (!retryable || attempt === maxAttempts - 1) {
          const errorMethod = failed
            ? entries[ids.get(failed.id)]?.method ?? "batch"
            : "batch";
          throw new Error(rpcErrorMessage(errorMethod, response.status, failed ?? body));
        }
        const retryAfterSeconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
        const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0;
        await sleepImpl(Math.max(retryAfterMs, 500 * 2 ** attempt));
      }
      throw new Error("Base JSON-RPC batch exhausted its retry budget.");
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return request;
}

function normalizedAddress(value, field) {
  const address = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid ${field} address.`);
  return address;
}

function normalizedHash(value) {
  const hash = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid Base transaction hash.");
  return hash;
}

function abiWord(input, index) {
  const start = 10 + index * 64;
  return input.slice(start, start + 64);
}

export function decodeX402AuthorizationInput({ input, transactionHash, timestamp, logIndex = 0 }) {
  const normalizedInput = String(input ?? "").toLowerCase();
  if (
    !X402_AUTHORIZATION_SELECTORS.has(normalizedInput.slice(0, 10)) ||
    normalizedInput.length < 10 + 3 * 64
  ) {
    return null;
  }
  const from = normalizedAddress(`0x${abiWord(normalizedInput, 0).slice(24)}`, "x402 payer");
  const to = normalizedAddress(`0x${abiWord(normalizedInput, 1).slice(24)}`, "x402 recipient");
  const amountRaw = BigInt(`0x${abiWord(normalizedInput, 2)}`);
  const observedAt = new Date(timestamp);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid Base activity timestamp.");
  return {
    transactionHash: normalizedHash(transactionHash),
    from,
    to,
    amountRaw,
    logIndex,
    timestamp: observedAt.toISOString(),
    activityDate: observedAt.toISOString().slice(0, 10),
  };
}

export function decodeTransferWithAuthorizationTrace(trace, timestamp, logIndex = 0) {
  if (trace?.error || trace?.type !== "call") return null;
  return decodeX402AuthorizationInput({
    input: trace.action?.input,
    transactionHash: trace.transactionHash,
    timestamp,
    logIndex,
  });
}

function topicAddress(topic, field) {
  const normalized = String(topic ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`Invalid ${field} topic.`);
  return normalizedAddress(`0x${normalized.slice(-40)}`, field);
}

export function transfersFromUsdcReceipt(receipt, timestamp, tokenAddress = BASE_USDC_ADDRESS) {
  if (!receipt || receipt.status !== "0x1" || !Array.isArray(receipt.logs)) return [];
  const observedAt = new Date(timestamp);
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid Base activity timestamp.");
  const expectedToken = normalizedAddress(tokenAddress, "USDC token");
  return receipt.logs
    .filter((log) =>
      String(log.address ?? "").toLowerCase() === expectedToken &&
      String(log.topics?.[0] ?? "").toLowerCase() === ERC20_TRANSFER_TOPIC &&
      log.topics?.length >= 3,
    )
    .map((log) => ({
      transactionHash: normalizedHash(log.transactionHash ?? receipt.transactionHash),
      from: topicAddress(log.topics[1], "USDC sender"),
      to: topicAddress(log.topics[2], "USDC recipient"),
      amountRaw: BigInt(String(log.data ?? "0x0")),
      logIndex: Number.parseInt(log.logIndex ?? "0x0", 16),
      timestamp: observedAt.toISOString(),
      activityDate: observedAt.toISOString().slice(0, 10),
    }));
}

export function x402IdentityActivitiesFromPayments(payments) {
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
      volumeUsdMicros: 0,
      firstSeenAt: payment.timestamp,
      lastSeenAt: payment.timestamp,
      evidenceLevel: "deterministic",
    };
    current.transactionCount += 1;
    const nextVolume = BigInt(current.volumeUsdMicros) + amountRaw;
    if (nextVolume > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("x402 identity volume exceeds the safe integer range.");
    }
    current.volumeUsdMicros = Number(nextVolume);
    if (payment.timestamp < current.firstSeenAt) current.firstSeenAt = payment.timestamp;
    if (payment.timestamp > current.lastSeenAt) current.lastSeenAt = payment.timestamp;
    activities.set(key, current);
  };
  for (const payment of payments) {
    add(payment, "payer", payment.from, payment.amountRaw);
    add(payment, "payee", payment.to, payment.recipientAmountRaw);
  }
  return [...activities.values()].sort((left, right) =>
    [left.activityMonth, left.role, left.identityHash]
      .join("|")
      .localeCompare([right.activityMonth, right.role, right.identityHash].join("|")),
  );
}

export function x402IdentityActivitiesFromTransfers(transfers) {
  return x402IdentityActivitiesFromPayments(collapseX402TransferChains(transfers));
}

export async function blockRangeForDates(rpc, from, to) {
  const latest = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  if (!Number.isSafeInteger(latest)) throw new Error("Base latest block number is invalid.");
  const cache = new Map();
  async function block(number) {
    if (!cache.has(number)) {
      const result = await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
      if (!result) throw new Error(`Base block ${number} was not found.`);
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
    latest,
    fromBlock: await firstAtOrAfter(from),
    toBlockExclusive: await firstAtOrAfter(to),
  };
}

function traceFilter(fromBlock, toBlockExclusive, facilitatorAddresses) {
  return {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${(toBlockExclusive - 1).toString(16)}`,
    fromAddress: facilitatorAddresses,
  };
}

async function traceRange(rpc, start, endExclusive, facilitatorAddresses) {
  try {
    return await rpc("trace_filter", [traceFilter(start, endExclusive, facilitatorAddresses)]);
  } catch (error) {
    if (error.billingBlocked || !error.splittable || endExclusive - start <= 1) throw error;
    const middle = Math.floor((start + endExclusive) / 2);
    const left = await traceRange(rpc, start, middle, facilitatorAddresses);
    const right = await traceRange(rpc, middle, endExclusive, facilitatorAddresses);
    return [...left, ...right];
  }
}

export async function collectX402BaseRpcChunk({
  rpc,
  fromBlock,
  toBlockExclusive,
  facilitatorAddresses,
  timestamp,
  tokenAddress = BASE_USDC_ADDRESS,
  verifyDirectReceipts = 0,
}) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlockExclusive) || toBlockExclusive <= fromBlock) {
    throw new Error("A valid Base block chunk is required.");
  }
  const addresses = [...new Set(facilitatorAddresses.map((address) =>
    normalizedAddress(address, "facilitator"),
  ))];
  if (!addresses.length) throw new Error("At least one facilitator address is required.");
  const traces = await traceRange(rpc, fromBlock, toBlockExclusive, addresses);
  const byTransaction = new Map();
  for (const trace of traces ?? []) {
    if (trace?.error || trace?.type !== "call" || !trace.transactionHash) continue;
    const hash = normalizedHash(trace.transactionHash);
    const rows = byTransaction.get(hash) ?? [];
    rows.push(trace);
    byTransaction.set(hash, rows);
  }

  const transfers = [];
  let receiptFallbackCount = 0;
  let directTransactionCount = 0;
  let verifiedDirectCount = 0;
  for (const [transactionHash, transactionTraces] of byTransaction) {
    const direct = transactionTraces
      .filter((trace) => String(trace.action?.to ?? "").toLowerCase() === tokenAddress.toLowerCase())
      .map((trace, index) => decodeTransferWithAuthorizationTrace(trace, timestamp, index))
      .filter(Boolean);
    if (direct.length) {
      directTransactionCount += 1;
      transfers.push(...direct);
      if (verifiedDirectCount < verifyDirectReceipts) {
        const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
        const receiptTransfers = transfersFromUsdcReceipt(receipt, timestamp, tokenAddress);
        const directSignature = direct
          .map((row) => [row.from, row.to, row.amountRaw.toString()].join("|"))
          .sort();
        const receiptSignature = receiptTransfers
          .filter((row) => directSignature.includes([row.from, row.to, row.amountRaw.toString()].join("|")))
          .map((row) => [row.from, row.to, row.amountRaw.toString()].join("|"))
          .sort();
        if (JSON.stringify(directSignature) !== JSON.stringify(receiptSignature)) {
          throw new Error(`Direct USDC calldata did not match receipt logs for ${transactionHash}.`);
        }
        verifiedDirectCount += 1;
      }
      continue;
    }
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
    const receiptTransfers = transfersFromUsdcReceipt(receipt, timestamp, tokenAddress);
    if (receiptTransfers.length) {
      transfers.push(...receiptTransfers);
      receiptFallbackCount += 1;
    }
  }

  return {
    fromBlock,
    toBlockExclusive,
    traceCount: traces?.length ?? 0,
    transactionCount: byTransaction.size,
    directTransactionCount,
    receiptFallbackCount,
    transferCount: transfers.length,
    activities: x402IdentityActivitiesFromTransfers(transfers),
  };
}
