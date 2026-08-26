#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadIdentityManifest } from "./lib/identity-manifest.mjs";

const DAY_MS = 86_400_000;

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
    options[value.slice(2)] = next;
    index += 1;
  }
  return options;
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function integer(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return number;
}

function utcDays(from, to) {
  const days = [];
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += DAY_MS) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

function validateCheckpoint(manifest) {
  if (
    ![1, 2].includes(manifest.schemaVersion) ||
    manifest.protocol !== "x402" ||
    !Array.isArray(manifest.summaries) ||
    !Array.isArray(manifest.segmentFiles)
  ) {
    throw new Error("The input is not a compatible x402 event-history manifest.");
  }
  if (!manifest.checkpoint?.complete) {
    throw new Error(
      `Backfill is incomplete (${manifest.checkpoint?.completedSlices ?? 0}/` +
        `${manifest.checkpoint?.totalSlices ?? "?"} slices).`,
    );
  }
  const from = new Date(manifest.rangeStart);
  const to = new Date(manifest.rangeEnd);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("Manifest range is invalid.");
  }
  return { from, to };
}

function validateSliceCoverage(manifest, from, to) {
  const summaries = [...manifest.summaries].sort((left, right) =>
    left.sliceStart.localeCompare(right.sliceStart),
  );
  if (summaries.length !== manifest.checkpoint.totalSlices) {
    throw new Error(
      `Manifest has ${summaries.length} slice summaries; expected ` +
        `${manifest.checkpoint.totalSlices}.`,
    );
  }
  let cursor = from.toISOString();
  const keys = new Set();
  for (const summary of summaries) {
    const key = `${summary.sliceStart}|${summary.sliceEnd}`;
    if (keys.has(key)) throw new Error(`Duplicate interval ${key}.`);
    keys.add(key);
    if (summary.sliceStart !== cursor) {
      throw new Error(`Interval gap: expected ${cursor}, received ${summary.sliceStart}.`);
    }
    const start = new Date(summary.sliceStart);
    const end = new Date(summary.sliceEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      throw new Error(`Invalid interval ${key}.`);
    }
    cursor = end.toISOString();
  }
  if (cursor !== to.toISOString()) {
    throw new Error(`Coverage ends at ${cursor}; expected ${to.toISOString()}.`);
  }
  return summaries;
}

function emptyMetric(activityDate, limitation) {
  return {
    activityDate,
    measurementUnit: "onchain_settlement",
    transactionCount: 0,
    settlementCount: 0,
    rawTransferCount: 0,
    volumeUsdMicros: 0,
    recipientVolumeUsdMicros: 0,
    grossVolumeUsdMicros: 0,
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
    trustAmountHistogram: new Map(),
    evidenceLevel: "deterministic",
    isAdjusted: false,
    limitation,
  };
}

function mergeHistogram(target, rows, field) {
  if (!Array.isArray(rows)) throw new Error(`${field} must be an array.`);
  for (const row of rows) {
    const amount = String(row?.amountUsdMicros ?? "");
    if (!/^\d+$/.test(amount)) throw new Error(`${field} has an invalid amount.`);
    const count = integer(row?.count, `${field}.count`);
    if (count < 1) throw new Error(`${field}.count must be positive.`);
    target.set(amount, (target.get(amount) ?? 0) + count);
  }
}

function summarizeHistogram(histogram, field) {
  const rows = [...histogram.entries()]
    .map(([amount, count]) => ({ amount: BigInt(amount), count: integer(count, `${field}.count`) }))
    .sort((left, right) => left.amount < right.amount ? -1 : left.amount > right.amount ? 1 : 0);
  const count = rows.reduce((total, row) => total + row.count, 0);
  const volume = rows.reduce((total, row) => total + row.amount * BigInt(row.count), 0n);
  const valueAt = (position) => {
    let cursor = 0;
    for (const row of rows) {
      cursor += row.count;
      if (position < cursor) return row.amount;
    }
    return 0n;
  };
  const lower = count === 0 ? 0n : valueAt(Math.floor((count - 1) / 2));
  const upper = count === 0 ? 0n : valueAt(Math.floor(count / 2));
  const median = (lower + upper) / 2n;
  const safe = (value, label) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${field}.${label} exceeds the safe integer range.`);
    }
    return number;
  };
  return {
    count,
    volumeUsdMicros: safe(volume, "volumeUsdMicros"),
    medianPaymentUsdMicros: safe(median, "medianPaymentUsdMicros"),
    maxPaymentUsdMicros: safe(rows.at(-1)?.amount ?? 0n, "maxPaymentUsdMicros"),
  };
}

function addMetric(target, source) {
  for (const field of [
    "transactionCount",
    "settlementCount",
    "rawTransferCount",
    "volumeUsdMicros",
    "recipientVolumeUsdMicros",
    "grossVolumeUsdMicros",
    "qualifyingPaymentCount",
    "qualifyingVolumeUsdMicros",
    "overOneCount",
    "overTenCount",
    "overHundredCount",
    "overThousandCount",
    "excludedZeroCount",
    "excludedSelfCount",
  ]) {
    target[field] += integer(source[field], field);
  }
  target.maxPaymentUsdMicros = Math.max(
    target.maxPaymentUsdMicros,
    integer(source.maxPaymentUsdMicros, "maxPaymentUsdMicros"),
  );
}

async function identitySets(manifestPath, manifest, days) {
  const byDay = new Map(days.map((day) => [day, { payers: new Set(), payees: new Set() }]));
  const all = { payers: new Set(), payees: new Set() };
  const base = dirname(manifestPath);
  let activities = 0;
  for (const file of manifest.segmentFiles) {
    const segment = await loadJson(resolve(base, file));
    if (segment.protocol !== "x402" || !Array.isArray(segment.activities)) {
      throw new Error(`Invalid identity segment: ${file}`);
    }
    for (const activity of segment.activities) {
      if (
        !["payer", "payee"].includes(activity.role) ||
        typeof activity.identityHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(activity.identityHash)
      ) {
        throw new Error(`Invalid privacy-safe activity in ${file}.`);
      }
      const timestamp = new Date(activity.firstSeenAt);
      if (!Number.isFinite(timestamp.getTime())) {
        throw new Error(`Invalid activity timestamp in ${file}.`);
      }
      const day = timestamp.toISOString().slice(0, 10);
      if (!byDay.has(day)) throw new Error(`Activity ${day} falls outside manifest coverage.`);
      const role = activity.role === "payer" ? "payers" : "payees";
      byDay.get(day)[role].add(activity.identityHash);
      all[role].add(activity.identityHash);
      activities += 1;
    }
  }
  return { byDay, all, activities };
}

function sum(metrics, field) {
  return metrics.reduce((total, metric) => total + integer(metric[field], field), 0);
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options.manifest) throw new Error("--manifest is required.");
  if (!options.output) throw new Error("--output is required.");
  const manifestPath = resolve(options.manifest);
  const manifest = await loadIdentityManifest(manifestPath);
  const { from, to } = validateCheckpoint(manifest);
  const summaries = validateSliceCoverage(manifest, from, to);
  const days = utcDays(from, to);
  const sourceLimitation =
    summaries.find((summary) => summary.collection?.windowSummary?.limitation)?.collection
      ?.windowSummary?.limitation ??
    "Base USDC settlements identified from x402 authorization and facilitator events. " +
      "Receive-forward chains count once at the original payer amount and terminal recipient.";
  const limitation = sourceLimitation;
  const byDay = new Map(days.map((day) => [day, emptyMetric(day, limitation)]));
  let inputRowCount = 0;
  for (const summary of summaries) {
    inputRowCount += integer(
      summary.collection?.signalLogCount ?? summary.collection?.paymentCount,
      "inputRowCount",
    );
    for (const metric of summary.collection?.metrics ?? []) {
      const target = byDay.get(metric.activityDate);
      if (!target) throw new Error(`Metric ${metric.activityDate} falls outside coverage.`);
      addMetric(target, metric);
      mergeHistogram(
        target.trustAmountHistogram,
        metric.trustAmountHistogram,
        `${summary.sliceStart}.trustAmountHistogram`,
      );
    }
  }
  const identities = await identitySets(manifestPath, manifest, days);
  for (const [day, sets] of identities.byDay) {
    byDay.get(day).buyerCount = sets.payers.size;
    byDay.get(day).sellerCount = sets.payees.size;
  }
  const allTimeHistogram = new Map();
  const metrics = days.map((day) => {
    const metric = byDay.get(day);
    const trust = summarizeHistogram(metric.trustAmountHistogram, `${day}.trustAmountHistogram`);
    if (
      trust.count !== metric.qualifyingPaymentCount ||
      trust.volumeUsdMicros !== metric.qualifyingVolumeUsdMicros
    ) {
      throw new Error(`Ticket-size distribution does not reconcile for ${day}.`);
    }
    mergeHistogram(
      allTimeHistogram,
      [...metric.trustAmountHistogram].map(([amountUsdMicros, count]) => ({
        amountUsdMicros,
        count,
      })),
      `${day}.allTimeHistogram`,
    );
    const published = { ...metric };
    delete published.trustAmountHistogram;
    return {
      ...published,
      medianPaymentUsdMicros: trust.medianPaymentUsdMicros,
      maxPaymentUsdMicros: trust.maxPaymentUsdMicros,
    };
  });
  const allTimeTrust = summarizeHistogram(allTimeHistogram, "allTimeTrustAmountHistogram");
  if (
    allTimeTrust.count !== sum(metrics, "qualifyingPaymentCount") ||
    allTimeTrust.volumeUsdMicros !== sum(metrics, "qualifyingVolumeUsdMicros")
  ) {
    throw new Error("The all-time ticket-size distribution does not reconcile.");
  }
  const queryHash = sha256(JSON.stringify({
    source: "x402-base-eip3009-events",
    terminalRecipientClassifier: "receive-forward-terminal-v1",
    rangeStart: from.toISOString(),
    rangeEnd: to.toISOString(),
    slices: summaries.map((summary) => [summary.sliceStart, summary.sliceEnd]),
    identitySegments: manifest.segmentFiles,
  }));
  const evidence = {
    sourceKey: "direct:x402:base-usdc:rpc-events:terminal-recipient-v1",
    protocol: "x402",
    network: "base",
    queryHash,
    inputRowCount,
    metrics,
    windowSummary: {
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      measurementUnit: "onchain_settlement",
      transactionCount: sum(metrics, "transactionCount"),
      settlementCount: sum(metrics, "settlementCount"),
      rawTransferCount: sum(metrics, "rawTransferCount"),
      volumeUsdMicros: sum(metrics, "volumeUsdMicros"),
      recipientVolumeUsdMicros: sum(metrics, "recipientVolumeUsdMicros"),
      grossVolumeUsdMicros: sum(metrics, "grossVolumeUsdMicros"),
      buyerCount: identities.all.payers.size,
      sellerCount: identities.all.payees.size,
      qualifyingPaymentCount: sum(metrics, "qualifyingPaymentCount"),
      qualifyingVolumeUsdMicros: sum(metrics, "qualifyingVolumeUsdMicros"),
      medianPaymentUsdMicros: allTimeTrust.medianPaymentUsdMicros,
      maxPaymentUsdMicros: allTimeTrust.maxPaymentUsdMicros,
      overOneCount: sum(metrics, "overOneCount"),
      overTenCount: sum(metrics, "overTenCount"),
      overHundredCount: sum(metrics, "overHundredCount"),
      overThousandCount: sum(metrics, "overThousandCount"),
      excludedZeroCount: sum(metrics, "excludedZeroCount"),
      excludedSelfCount: sum(metrics, "excludedSelfCount"),
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    },
    coverage: {
      measurementUnit: "onchain_settlement",
      sourceType: "chain_rpc",
      sourceUrl: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
      coverageStart: from.toISOString(),
      coverageEnd: to.toISOString(),
      status: Date.now() - to.getTime() < 36 * 3_600_000 ? "active" : "backfilling",
      limitation,
      methodologyUrl: "https://agenticpaymentsindex.org/methodology",
    },
  };
  const output = resolve(options.output);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    rangeStart: from.toISOString(),
    rangeEnd: to.toISOString(),
    days: metrics.length,
    slices: summaries.length,
    segmentFiles: manifest.segmentFiles.length,
    identityActivities: identities.activities,
    transactions: evidence.windowSummary.transactionCount,
    qualifyingPayments: evidence.windowSummary.qualifyingPaymentCount,
    buyers: evidence.windowSummary.buyerCount,
    recipients: evidence.windowSummary.sellerCount,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
