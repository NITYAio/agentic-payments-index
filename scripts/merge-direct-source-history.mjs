#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseDateRange, sha256Hex } from "./lib/direct-source.mjs";

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

function list(value, field) {
  if (!value) throw new Error(`${field} is required.`);
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function identitySets(manifestPaths, protocol) {
  const payers = new Set();
  const payees = new Set();
  for (const manifestPath of manifestPaths) {
    const absoluteManifest = resolve(manifestPath);
    const manifest = await loadJson(absoluteManifest);
    if (manifest.protocol !== protocol || !Array.isArray(manifest.segmentFiles)) {
      throw new Error(`Identity manifest does not match ${protocol}: ${manifestPath}`);
    }
    for (const file of manifest.segmentFiles) {
      const segment = await loadJson(resolve(dirname(absoluteManifest), file));
      for (const activity of segment.activities ?? []) {
        if (activity.role === "payer") payers.add(activity.identityHash);
        if (
          activity.role === "payee" &&
          (protocol !== "mpp" || activity.identityScheme === "mpp-server-fingerprint")
        ) {
          payees.add(activity.identityHash);
        }
      }
    }
  }
  return { payers, payees };
}

function sum(metrics, field) {
  return metrics.reduce((total, metric) => total + Number(metric[field] ?? 0), 0);
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.protocol !== "mpp" && options.protocol !== "x402") {
    throw new Error("--protocol must be mpp or x402.");
  }
  const { from, to } = parseDateRange(options.from, options.to);
  const inputPaths = list(options.inputs, "--inputs").map((path) => resolve(path));
  const manifestPaths = list(options["identity-manifests"], "--identity-manifests");
  const evidence = await Promise.all(inputPaths.map(loadJson));
  if (evidence.some((item) => item.protocol !== options.protocol)) {
    throw new Error("Every aggregate evidence file must match --protocol.");
  }
  const byDate = new Map();
  for (const item of evidence) {
    for (const metric of item.metrics ?? []) {
      const timestamp = new Date(`${metric.activityDate}T00:00:00.000Z`);
      if (timestamp < from || timestamp >= to) continue;
      if (byDate.has(metric.activityDate)) {
        throw new Error(`Aggregate evidence overlaps on ${metric.activityDate}.`);
      }
      byDate.set(metric.activityDate, metric);
    }
  }
  const metrics = [...byDate.values()].sort((left, right) =>
    left.activityDate.localeCompare(right.activityDate),
  );
  const expectedDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
  if (metrics.length !== expectedDays) {
    throw new Error(`Aggregate history has ${metrics.length} daily rows; expected ${expectedDays}.`);
  }
  const { payers, payees } = await identitySets(manifestPaths, options.protocol);
  const first = evidence[0];
  const limitation = [
    first.windowSummary?.limitation ?? first.coverage?.limitation,
    "All-time payer and recipient counts are deduplicated from locally hashed monthly identity activity; raw identity keys are not retained.",
  ].filter(Boolean).join(" ");
  const result = {
    sourceKey: first.sourceKey,
    protocol: options.protocol,
    network: first.network,
    queryHash: sha256Hex(JSON.stringify({
      aggregateQueries: evidence.map((item) => item.queryHash),
      identityManifests: manifestPaths,
      from: from.toISOString(),
      to: to.toISOString(),
    })),
    inputRowCount: evidence.reduce((total, item) => total + Number(item.inputRowCount ?? 0), 0),
    metrics,
    windowSummary: {
      rangeStart: from.toISOString(),
      rangeEnd: to.toISOString(),
      measurementUnit: first.windowSummary.measurementUnit,
      transactionCount: sum(metrics, "transactionCount"),
      chargeCount: sum(metrics, "chargeCount"),
      sessionCount: sum(metrics, "sessionCount"),
      settlementCount: sum(metrics, "settlementCount"),
      rawTransferCount: sum(metrics, "rawTransferCount"),
      volumeUsdMicros: sum(metrics, "volumeUsdMicros"),
      recipientVolumeUsdMicros: sum(metrics, "recipientVolumeUsdMicros"),
      grossVolumeUsdMicros: sum(metrics, "grossVolumeUsdMicros"),
      chargeVolumeUsdMicros: sum(metrics, "chargeVolumeUsdMicros"),
      sessionVolumeUsdMicros: sum(metrics, "sessionVolumeUsdMicros"),
      buyerCount: payers.size,
      sellerCount: payees.size,
      evidenceLevel: "deterministic",
      isAdjusted: false,
      limitation,
    },
    coverage: {
      ...first.coverage,
      coverageStart: from.toISOString(),
      coverageEnd: to.toISOString(),
      status: Date.now() - to.getTime() < 36 * 60 * 60 * 1_000 ? "active" : "backfilling",
      limitation,
    },
  };
  const output = resolve(options.output);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    protocol: result.protocol,
    rangeStart: result.windowSummary.rangeStart,
    rangeEnd: result.windowSummary.rangeEnd,
    transactionCount: result.windowSummary.transactionCount,
    volumeUsdMicros: result.windowSummary.volumeUsdMicros,
    buyerCount: result.windowSummary.buyerCount,
    sellerCount: result.windowSummary.sellerCount,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
