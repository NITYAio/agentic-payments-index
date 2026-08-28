import { sha256Hex } from "./direct-source.mjs";

export const X402_SUBSTREAMS_SOURCE_KEY =
  "identity:x402:base-usdc:substreams-pulse-v3.3.0";

function normalizedAddress(value) {
  const address = String(value ?? "").toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

function timestampFrom(value) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (value && typeof value === "object") {
    const seconds = Number(value.seconds ?? value.Seconds);
    const nanos = Number(value.nanos ?? value.Nanos ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return new Date(seconds * 1_000 + Math.floor(nanos / 1_000_000)).toISOString();
    }
  }
  return null;
}

function findSettlementEnvelope(value, depth = 0, inheritedTimestamp = null) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  const timestamp = timestampFrom(
    value.blockTimestamp ?? value.block_timestamp ?? value.timestamp,
  ) ?? inheritedTimestamp;
  if (Array.isArray(value.settlements)) {
    return { settlements: value.settlements, blockTimestamp: timestamp };
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findSettlementEnvelope(child, depth + 1, timestamp);
    if (found) return found;
  }
  return null;
}

export function settlementsFromJsonLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  const parsed = JSON.parse(trimmed);
  return findSettlementEnvelope(parsed);
}

export function createSubstreamsIdentityAccumulator({ from, to }) {
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  if (
    !Number.isFinite(rangeStart.getTime()) ||
    !Number.isFinite(rangeEnd.getTime()) ||
    rangeEnd <= rangeStart
  ) {
    throw new Error("A valid x402 Substreams date range is required.");
  }
  const activities = new Map();
  const settlementIds = new Set();
  let settlementCount = 0;
  let skippedOutsideRange = 0;
  let skippedInvalid = 0;

  function add({ role, identity, amountRaw, timestamp }) {
    const identityHash = sha256Hex(`x402|base|evm|${identity}`);
    const activityMonth = timestamp.slice(0, 7);
    const key = [role, identityHash, activityMonth].join("|");
    const current = activities.get(key) ?? {
      role,
      identityScheme: "evm",
      identityHash,
      activityMonth,
      transactionCount: 0,
      volumeUsdMicros: 0,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      evidenceLevel: "deterministic",
    };
    current.transactionCount += 1;
    const nextVolume = BigInt(current.volumeUsdMicros) + amountRaw;
    if (nextVolume > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("x402 identity volume exceeds the safe integer range.");
    }
    current.volumeUsdMicros = Number(nextVolume);
    if (timestamp < current.firstSeenAt) current.firstSeenAt = timestamp;
    if (timestamp > current.lastSeenAt) current.lastSeenAt = timestamp;
    activities.set(key, current);
  }

  function consume(envelope) {
    if (!envelope) return;
    for (const settlement of envelope.settlements) {
      const payer = normalizedAddress(settlement.payer);
      const recipient = normalizedAddress(settlement.recipient);
      const timestamp = timestampFrom(settlement.timestamp) ?? envelope.blockTimestamp;
      let amountRaw;
      try {
        amountRaw = BigInt(String(settlement.amount ?? ""));
      } catch {
        skippedInvalid += 1;
        continue;
      }
      if (!timestamp || (!payer && !recipient) || amountRaw < 0n) {
        skippedInvalid += 1;
        continue;
      }
      const observedAt = new Date(timestamp);
      if (observedAt < rangeStart || observedAt >= rangeEnd) {
        skippedOutsideRange += 1;
        continue;
      }
      const id = String(
        settlement.id ??
          `${settlement.txHash ?? settlement.tx_hash ?? "unknown"}-${settlement.logIndex ?? settlement.log_index ?? "0"}`,
      ).toLowerCase();
      if (settlementIds.has(id)) continue;
      settlementIds.add(id);
      settlementCount += 1;
      if (payer) add({ role: "payer", identity: payer, amountRaw, timestamp });
      if (recipient) add({ role: "payee", identity: recipient, amountRaw, timestamp });
    }
  }

  function result() {
    return {
      settlementCount,
      skippedOutsideRange,
      skippedInvalid,
      activities: [...activities.values()].sort((left, right) =>
        [left.activityMonth, left.role, left.identityHash]
          .join("|")
          .localeCompare([right.activityMonth, right.role, right.identityHash].join("|")),
      ),
    };
  }

  return { consume, result };
}
