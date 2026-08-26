#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadIdentityManifest } from "./lib/identity-manifest.mjs";

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--no-ingest") options.noIngest = true;
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

function monthIndex(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

function monthFromIndex(index) {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function monthFromTimestamp(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function previousCompleteMonth(now) {
  return monthFromIndex(now.getUTCFullYear() * 12 + now.getUTCMonth() - 1);
}

async function loadManifest(pathValue) {
  const manifest = await loadIdentityManifest(pathValue);
  const path = manifest.path;
  if (
    ![1, 2].includes(manifest.schemaVersion) ||
    !["mpp", "x402"].includes(manifest.protocol) ||
    !Array.isArray(manifest.segmentFiles) ||
    !manifest.segmentFiles.length
  ) {
    throw new Error(`${path} is not a compatible identity manifest.`);
  }
  return manifest;
}

function identityState() {
  return new Map([
    ["payer", { byMonth: new Map(), firstMonth: new Map() }],
    ["payee", { byMonth: new Map(), firstMonth: new Map() }],
  ]);
}

async function loadIdentityState(manifests, completeThrough) {
  const state = identityState();
  const sourceKeys = new Set();
  for (const manifest of manifests) {
    const base = dirname(manifest.path);
    for (const segmentFile of manifest.segmentFiles) {
      const segment = JSON.parse(await readFile(resolve(base, segmentFile), "utf8"));
      if (typeof segment.sourceKey === "string") sourceKeys.add(segment.sourceKey);
      for (const activity of segment.activities ?? []) {
        if (
          !["payer", "payee"].includes(activity.role) ||
          typeof activity.identityHash !== "string" ||
          typeof activity.activityMonth !== "string" ||
          activity.activityMonth > completeThrough
        ) {
          continue;
        }
        const role = state.get(activity.role);
        const identity = `${manifest.protocol}|${activity.identityScheme}|${activity.identityHash}`;
        const active = role.byMonth.get(activity.activityMonth) ?? new Set();
        active.add(identity);
        role.byMonth.set(activity.activityMonth, active);
        const first = role.firstMonth.get(identity);
        if (!first || activity.activityMonth < first) {
          role.firstMonth.set(identity, activity.activityMonth);
        }
      }
    }
  }
  return { state, sourceKeys: [...sourceKeys].sort() };
}

function intersections(members, active) {
  if (!members.size || !active?.size) return 0;
  let retained = 0;
  const smaller = members.size <= active.size ? members : active;
  const larger = members.size <= active.size ? active : members;
  for (const identity of smaller) if (larger.has(identity)) retained += 1;
  return retained;
}

function cellsFromState(state, coverageStart, completeThrough) {
  const cells = [];
  const start = monthIndex(monthFromTimestamp(coverageStart));
  const end = monthIndex(completeThrough);
  for (const roleName of ["payer", "payee"]) {
    const role = state.get(roleName);
    for (const mode of ["activity", "acquisition"]) {
      for (let cohortIndex = start; cohortIndex <= end; cohortIndex += 1) {
        const cohortMonth = monthFromIndex(cohortIndex);
        const active = role.byMonth.get(cohortMonth) ?? new Set();
        const members =
          mode === "activity"
            ? active
            : new Set([...active].filter((identity) => role.firstMonth.get(identity) === cohortMonth));
        for (let calendarIndex = cohortIndex; calendarIndex <= end; calendarIndex += 1) {
          const calendarMonth = monthFromIndex(calendarIndex);
          const offset = calendarIndex - cohortIndex;
          cells.push({
            role: roleName,
            mode,
            cohortMonth,
            offset,
            calendarMonth,
            cohortSize: members.size,
            retained: offset === 0
              ? members.size
              : intersections(members, role.byMonth.get(calendarMonth)),
            leftCensored: mode === "acquisition" && cohortIndex === start,
          });
        }
      }
    }
  }
  return cells;
}

async function buildSnapshot(protocol, manifests, now) {
  const coverageStart = manifests
    .map((manifest) => new Date(manifest.rangeStart).toISOString())
    .sort()[0];
  const coverageEnd = manifests
    .map((manifest) => new Date(manifest.rangeEnd).toISOString())
    .sort()
    .at(-1);
  const completeThrough = monthFromIndex(
    Math.min(
      monthIndex(monthFromTimestamp(coverageEnd)),
      monthIndex(previousCompleteMonth(now)),
    ),
  );
  const { state, sourceKeys } = await loadIdentityState(manifests, completeThrough);
  return {
    schemaVersion: 1,
    privacy:
      "Exact aggregate retention cells only; no raw or hashed identity identifiers are included.",
    protocol,
    sourceKeys,
    coverageStart,
    coverageEnd,
    completeThrough,
    cells: cellsFromState(state, coverageStart, completeThrough),
  };
}

async function ingest(snapshot, options) {
  if (options.noIngest) return { status: "not_requested" };
  const ingestUrl = options["ingest-url"] ?? process.env.COHORT_SNAPSHOT_INGEST_URL;
  if (!ingestUrl) return { status: "not_configured" };
  const token = process.env.IDENTITY_INGEST_TOKEN;
  if (!token) throw new Error("IDENTITY_INGEST_TOKEN is required when an ingest URL is used.");
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) {
    throw new Error(`Cohort snapshot ingestion failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const manifests = [];
  if (options["mpp-manifest"]) manifests.push(await loadManifest(options["mpp-manifest"]));
  if (options["x402-manifest"]) manifests.push(await loadManifest(options["x402-manifest"]));
  if (!manifests.length) throw new Error("Provide --mpp-manifest and/or --x402-manifest.");
  const asOf = new Date(options["as-of"] ?? new Date().toISOString());
  if (!Number.isFinite(asOf.getTime())) throw new Error("--as-of must be a valid timestamp.");
  const outputDir = resolve(options["output-dir"] ?? "/private/tmp/agentic-index-cohort-snapshots");
  await mkdir(outputDir, { recursive: true });
  const targets = manifests.map((manifest) => ({
    protocol: manifest.protocol,
    manifests: [manifest],
  }));
  if (manifests.length > 1) targets.push({ protocol: "all", manifests });
  const results = [];
  for (const target of targets) {
    const snapshot = await buildSnapshot(target.protocol, target.manifests, asOf);
    const path = resolve(outputDir, `cohort-snapshot-${target.protocol}.json`);
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    results.push({
      protocol: target.protocol,
      path,
      cells: snapshot.cells.length,
      completeThrough: snapshot.completeThrough,
      ingestion: await ingest(snapshot, options),
    });
  }
  process.stdout.write(`${JSON.stringify({ outputDir, results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exitCode = 1;
});
