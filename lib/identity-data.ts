export type PaymentProtocol = "mpp" | "x402";
export type EvidenceType =
  | "mpp_receipt"
  | "x402_settlement"
  | "confirmed_chain"
  | "service_export";
export type EvidenceLevel =
  | "verified"
  | "deterministic"
  | "declared"
  | "inferred";

export type PaymentIdentity = {
  scheme: string;
  key: string;
};

export type NormalizedPaymentEvent = {
  id: string;
  protocol: PaymentProtocol;
  network: string;
  occurredAt: string;
  payer: PaymentIdentity;
  payee: PaymentIdentity;
  transactionCount?: number;
  volumeUsdMicros?: number;
  evidenceLevel: EvidenceLevel;
};

export type MonthlyActivityRecord = {
  id: string;
  segmentId: string;
  role: "payer" | "payee";
  protocol: PaymentProtocol;
  network: string;
  identityScheme: string;
  identityHash: string;
  activityMonth: string;
  transactionCount: number;
  volumeUsdMicros: number;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceLevel: EvidenceLevel;
};

export type PrehashedMonthlyActivity = Omit<
  MonthlyActivityRecord,
  "id" | "segmentId" | "protocol" | "network"
>;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function normalizedIdentity(identity: PaymentIdentity) {
  const scheme = identity.scheme.trim().toLowerCase();
  const rawKey = identity.key.trim();
  const key =
    scheme === "evm" ||
    scheme === "eip155" ||
    EVM_ADDRESS.test(rawKey) ||
    rawKey.toLowerCase().startsWith("did:pkh:eip155:")
      ? rawKey.toLowerCase()
      : rawKey;
  return { scheme, key };
}

async function sha256(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthForTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Event timestamp is invalid.");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function strictCount(value: number | undefined) {
  const count = value ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Transaction count must be a positive safe integer.");
  }
  return count;
}

function strictMicros(value: number | undefined) {
  const micros = value ?? 0;
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("USD volume must be a non-negative integer number of micros.");
  }
  return micros;
}

function strictTimestamp(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() > Date.now() + 86_400_000) {
    throw new Error(`${field} is invalid.`);
  }
  return timestamp.toISOString();
}

export function validatePrehashedMonthlyActivity(value: unknown): PrehashedMonthlyActivity {
  if (!value || typeof value !== "object") throw new Error("Activity must be an object.");
  const activity = value as Partial<PrehashedMonthlyActivity>;
  if (activity.role !== "payer" && activity.role !== "payee") {
    throw new Error("Activity role must be payer or payee.");
  }
  if (
    typeof activity.identityScheme !== "string" ||
    !activity.identityScheme.trim() ||
    activity.identityScheme.length > 100
  ) {
    throw new Error("Activity identity scheme is invalid.");
  }
  if (typeof activity.identityHash !== "string" || !SHA256_HEX.test(activity.identityHash)) {
    throw new Error("Activity identity hash must be a lowercase SHA-256 value.");
  }
  if (typeof activity.activityMonth !== "string" || !MONTH.test(activity.activityMonth)) {
    throw new Error("Activity month must use YYYY-MM.");
  }
  const firstSeenAt = strictTimestamp(activity.firstSeenAt, "Activity firstSeenAt");
  const lastSeenAt = strictTimestamp(activity.lastSeenAt, "Activity lastSeenAt");
  if (lastSeenAt < firstSeenAt) throw new Error("Activity lastSeenAt precedes firstSeenAt.");
  if (
    firstSeenAt.slice(0, 7) !== activity.activityMonth ||
    lastSeenAt.slice(0, 7) !== activity.activityMonth
  ) {
    throw new Error("Activity timestamps must fall within activityMonth.");
  }
  if (
    activity.evidenceLevel !== "verified" &&
    activity.evidenceLevel !== "deterministic" &&
    activity.evidenceLevel !== "declared" &&
    activity.evidenceLevel !== "inferred"
  ) {
    throw new Error("Activity evidence level is invalid.");
  }
  return {
    role: activity.role,
    identityScheme: activity.identityScheme.trim().toLowerCase(),
    identityHash: activity.identityHash,
    activityMonth: activity.activityMonth,
    transactionCount: strictCount(activity.transactionCount),
    volumeUsdMicros: strictMicros(activity.volumeUsdMicros),
    firstSeenAt,
    lastSeenAt,
    evidenceLevel: activity.evidenceLevel,
  };
}

export async function finalizePrehashedMonthlyActivity(
  segmentId: string,
  protocol: PaymentProtocol,
  network: string,
  activities: PrehashedMonthlyActivity[],
) {
  const normalizedNetwork = network.trim().toLowerCase();
  return Promise.all(
    activities.map(async (activity) => ({
      id: await sha256(
        [
          segmentId,
          activity.role,
          protocol,
          normalizedNetwork,
          activity.identityHash,
          activity.activityMonth,
          activity.evidenceLevel,
        ].join("|"),
      ),
      segmentId,
      protocol,
      network: normalizedNetwork,
      ...activity,
    } satisfies MonthlyActivityRecord)),
  );
}

export async function aggregateIdentityActivity(
  segmentId: string,
  events: NormalizedPaymentEvent[],
) {
  const aggregates = new Map<
    string,
    Omit<MonthlyActivityRecord, "id" | "identityHash"> & {
      canonicalIdentity: string;
    }
  >();

  for (const event of events) {
    const month = monthForTimestamp(event.occurredAt);
    const transactionCount = strictCount(event.transactionCount);
    const volumeUsdMicros = strictMicros(event.volumeUsdMicros);
    const timestamp = new Date(event.occurredAt).toISOString();
    for (const [role, rawIdentity] of [
      ["payer", event.payer],
      ["payee", event.payee],
    ] as const) {
      const identity = normalizedIdentity(rawIdentity);
      if (!identity.scheme || !identity.key) {
        throw new Error("Every payment must include payer and payee identities.");
      }
      const canonicalIdentity = [
        event.protocol,
        event.network.trim().toLowerCase(),
        identity.scheme,
        identity.key,
      ].join("|");
      const aggregateKey = [
        role,
        event.protocol,
        event.network.trim().toLowerCase(),
        identity.scheme,
        canonicalIdentity,
        month,
        event.evidenceLevel,
      ].join("|");
      const current = aggregates.get(aggregateKey);
      if (current) {
        current.transactionCount += transactionCount;
        current.volumeUsdMicros += volumeUsdMicros;
        if (timestamp < current.firstSeenAt) current.firstSeenAt = timestamp;
        if (timestamp > current.lastSeenAt) current.lastSeenAt = timestamp;
      } else {
        aggregates.set(aggregateKey, {
          segmentId,
          role,
          protocol: event.protocol,
          network: event.network.trim().toLowerCase(),
          identityScheme: identity.scheme,
          canonicalIdentity,
          activityMonth: month,
          transactionCount,
          volumeUsdMicros,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          evidenceLevel: event.evidenceLevel,
        });
      }
    }
  }

  return Promise.all(
    [...aggregates.values()].map(async (aggregate) => {
      const identityHash = await sha256(aggregate.canonicalIdentity);
      const id = await sha256(
        [
          aggregate.segmentId,
          aggregate.role,
          aggregate.protocol,
          aggregate.network,
          identityHash,
          aggregate.activityMonth,
          aggregate.evidenceLevel,
        ].join("|"),
      );
      return {
        id,
        identityHash,
        segmentId: aggregate.segmentId,
        role: aggregate.role,
        protocol: aggregate.protocol,
        network: aggregate.network,
        identityScheme: aggregate.identityScheme,
        activityMonth: aggregate.activityMonth,
        transactionCount: aggregate.transactionCount,
        volumeUsdMicros: aggregate.volumeUsdMicros,
        firstSeenAt: aggregate.firstSeenAt,
        lastSeenAt: aggregate.lastSeenAt,
        evidenceLevel: aggregate.evidenceLevel,
      } satisfies MonthlyActivityRecord;
    }),
  );
}

export function validateNormalizedEvent(value: unknown): NormalizedPaymentEvent {
  if (!value || typeof value !== "object") throw new Error("Event must be an object.");
  const event = value as Partial<NormalizedPaymentEvent>;
  if (typeof event.id !== "string" || !event.id.trim() || event.id.length > 240) {
    throw new Error("Every event requires a stable source id.");
  }
  if (event.protocol !== "mpp" && event.protocol !== "x402") {
    throw new Error("Event protocol must be MPP or x402.");
  }
  if (typeof event.network !== "string" || !event.network.trim() || event.network.length > 100) {
    throw new Error("Every event requires a network.");
  }
  if (typeof event.occurredAt !== "string") throw new Error("Every event requires occurredAt.");
  const timestamp = new Date(event.occurredAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + 86_400_000) {
    throw new Error("Event timestamp is invalid.");
  }
  for (const identity of [event.payer, event.payee]) {
    if (
      !identity ||
      typeof identity.scheme !== "string" ||
      !identity.scheme.trim() ||
      typeof identity.key !== "string" ||
      !identity.key.trim() ||
      identity.key.length > 400
    ) {
      throw new Error("Every event requires valid payer and payee identities.");
    }
  }
  if (
    event.evidenceLevel !== "verified" &&
    event.evidenceLevel !== "deterministic" &&
    event.evidenceLevel !== "declared" &&
    event.evidenceLevel !== "inferred"
  ) {
    throw new Error("Event evidence level is invalid.");
  }
  strictCount(event.transactionCount);
  strictMicros(event.volumeUsdMicros);
  return event as NormalizedPaymentEvent;
}
