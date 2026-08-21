import { createHash } from "node:crypto";

export const X402_INDEX_SOURCE_KEY =
  "identity:x402:base-usdc:x402scan-index:terminal-recipient-v1";
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedAddress(value, field) {
  const address = String(value ?? "").toLowerCase();
  if (!ADDRESS.test(address)) throw new Error(`${field} is not a Base address.`);
  return address;
}

function normalizedHash(value) {
  const hash = String(value ?? "").toLowerCase();
  if (!HASH.test(hash)) throw new Error("Transaction hash is invalid.");
  return hash;
}

function integer(value, field) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${field} must be a non-negative integer.`);
  return BigInt(text);
}

function amountMicros(amount, decimals) {
  const raw = integer(amount, "Payment amount");
  const precision = Number(decimals);
  if (!Number.isInteger(precision) || precision < 0 || precision > 36) {
    throw new Error("Token decimals are invalid.");
  }
  const micros = precision === 6
    ? raw
    : precision < 6
      ? raw * (10n ** BigInt(6 - precision))
      : raw / (10n ** BigInt(precision - 6));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Payment amount exceeds the safe integer range.");
  }
  return Number(micros);
}

export function normalizedIndexedPayment(value) {
  if (!value || typeof value !== "object") throw new Error("Indexed payment must be an object.");
  const timestamp = new Date(value.block_timestamp);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Payment timestamp is invalid.");
  const token = normalizedAddress(value.token_address ?? value.address, "Token address");
  if (token !== BASE_USDC_ADDRESS) {
    return null;
  }
  return {
    id: String(value.id ?? ""),
    transactionHash: normalizedHash(value.tx_hash),
    payer: normalizedAddress(value.sender, "Payer"),
    recipient: normalizedAddress(value.recipient, "Recipient"),
    token,
    amountRaw: integer(value.amount, "Payment amount").toString(),
    amountUsdMicros: amountMicros(value.amount, value.decimals),
    timestamp: timestamp.toISOString(),
    activityMonth: timestamp.toISOString().slice(0, 7),
  };
}

export function createIndexedIdentityAccumulator() {
  const activities = new Map();
  let indexedRows = 0;
  let excludedNonUsdc = 0;
  let totalVolumeUsdMicros = 0n;

  function add(payment, role, identity) {
    const identityHash = sha256Hex(`x402|base|evm|${identity}`);
    const key = [role, identityHash, payment.activityMonth].join("|");
    const current = activities.get(key) ?? {
      role,
      identityScheme: "evm",
      identityHash,
      activityMonth: payment.activityMonth,
      transactionCount: 0,
      volumeUsdMicros: 0,
      firstSeenAt: payment.timestamp,
      lastSeenAt: payment.timestamp,
      evidenceLevel: "deterministic",
    };
    current.transactionCount += 1;
    const nextVolume = BigInt(current.volumeUsdMicros) + BigInt(payment.amountUsdMicros);
    if (nextVolume > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Identity volume exceeds the safe integer range.");
    }
    current.volumeUsdMicros = Number(nextVolume);
    if (payment.timestamp < current.firstSeenAt) current.firstSeenAt = payment.timestamp;
    if (payment.timestamp > current.lastSeenAt) current.lastSeenAt = payment.timestamp;
    activities.set(key, current);
  }

  return {
    consume(value) {
      const payment = normalizedIndexedPayment(value);
      if (!payment) {
        excludedNonUsdc += 1;
        return null;
      }
      indexedRows += 1;
      totalVolumeUsdMicros += BigInt(payment.amountUsdMicros);
      add(payment, "payer", payment.payer);
      add(payment, "payee", payment.recipient);
      return payment;
    },
    result() {
      const rows = [...activities.values()].sort((left, right) =>
        [left.activityMonth, left.role, left.identityHash]
          .join("|")
          .localeCompare([right.activityMonth, right.role, right.identityHash].join("|")),
      );
      return {
        activities: rows,
        indexedRows,
        excludedNonUsdc,
        totalVolumeUsdMicros: totalVolumeUsdMicros.toString(),
      };
    },
  };
}

function topicAddress(topic) {
  const value = String(topic ?? "").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(value) ? `0x${value.slice(-40)}` : null;
}

export function verifyIndexedPaymentReceipt(payment, receipt) {
  if (!receipt || receipt.status !== "0x1" || !Array.isArray(receipt.logs)) {
    return { verified: false, reason: "missing_or_failed_receipt" };
  }
  const transfers = receipt.logs
    .filter((log) =>
      String(log.address ?? "").toLowerCase() === payment.token &&
      String(log.topics?.[0] ?? "").toLowerCase() === ERC20_TRANSFER_TOPIC &&
      log.topics?.length >= 3,
    )
    .map((log) => ({
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      amountRaw: BigInt(String(log.data ?? "0x0")).toString(),
    }));
  const terminalMatch = transfers.some((row) =>
    row.to === payment.recipient && row.amountRaw === payment.amountRaw,
  );
  const payerMatch = transfers.some((row) => row.from === payment.payer);
  return {
    verified: terminalMatch && payerMatch,
    reason: terminalMatch && payerMatch ? "matched" : "payment_legs_not_found",
    transferLogs: transfers.length,
  };
}

export function mergeConcentration(target, payment) {
  const identityHash = sha256Hex(`x402|base|evm|${payment.payer}`);
  const current = target.get(identityHash) ?? { transactionCount: 0, volumeUsdMicros: 0n };
  current.transactionCount += 1;
  current.volumeUsdMicros += BigInt(payment.amountUsdMicros);
  target.set(identityHash, current);
}

export function concentrationSummary(payers) {
  const ranked = [...payers.entries()]
    .map(([identityHash, values]) => ({ identityHash, ...values }))
    .sort((left, right) =>
      left.volumeUsdMicros === right.volumeUsdMicros
        ? right.transactionCount - left.transactionCount
        : left.volumeUsdMicros > right.volumeUsdMicros ? -1 : 1,
    );
  const totalVolume = ranked.reduce((sum, row) => sum + row.volumeUsdMicros, 0n);
  const totalTransactions = ranked.reduce((sum, row) => sum + row.transactionCount, 0);
  const share = (limit, field) => {
    const numerator = ranked.slice(0, limit).reduce(
      (sum, row) => sum + (field === "volume" ? row.volumeUsdMicros : BigInt(row.transactionCount)),
      0n,
    );
    const denominator = field === "volume" ? totalVolume : BigInt(totalTransactions);
    return denominator ? Number((numerator * 1_000_000n) / denominator) / 10_000 : 0;
  };
  return {
    uniquePayers: ranked.length,
    totalTransactions,
    totalVolumeUsdMicros: totalVolume.toString(),
    top1VolumeSharePct: share(1, "volume"),
    top2VolumeSharePct: share(2, "volume"),
    top10VolumeSharePct: share(10, "volume"),
    top1TransactionSharePct: share(1, "transactions"),
    top2TransactionSharePct: share(2, "transactions"),
    top10TransactionSharePct: share(10, "transactions"),
  };
}
