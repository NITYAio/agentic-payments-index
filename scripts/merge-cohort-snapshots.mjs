#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

async function load(path, protocol) {
  const snapshot = JSON.parse(await readFile(resolve(path), "utf8"));
  if (snapshot.protocol !== protocol || !Array.isArray(snapshot.cells)) {
    throw new Error(`${path} is not a ${protocol} cohort snapshot.`);
  }
  return snapshot;
}

function monthIndex(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

function cellKey(cell) {
  return [cell.role, cell.mode, cell.cohortMonth, cell.offset].join("|");
}

async function ingest(snapshot, options) {
  if (options.noIngest) return { status: "not_requested" };
  const ingestUrl = options["ingest-url"] ?? process.env.COHORT_SNAPSHOT_INGEST_URL;
  if (!ingestUrl) return { status: "not_configured" };
  const token = process.env.IDENTITY_INGEST_TOKEN;
  if (!token) throw new Error("IDENTITY_INGEST_TOKEN is required when an ingest URL is used.");
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) {
    throw new Error(`Combined cohort ingestion failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options.mpp || !options.x402 || !options.output) {
    throw new Error("--mpp, --x402, and --output are required.");
  }
  const mpp = await load(options.mpp, "mpp");
  const x402 = await load(options.x402, "x402");
  const completeThrough = monthIndex(mpp.completeThrough) <= monthIndex(x402.completeThrough)
    ? mpp.completeThrough
    : x402.completeThrough;
  const cells = new Map();
  for (const snapshot of [mpp, x402]) {
    for (const cell of snapshot.cells) {
      if (monthIndex(cell.calendarMonth) > monthIndex(completeThrough)) continue;
      const key = cellKey(cell);
      const existing = cells.get(key);
      if (!existing) cells.set(key, { ...cell });
      else {
        existing.cohortSize += cell.cohortSize;
        existing.retained += cell.retained;
        existing.leftCensored ||= cell.leftCensored;
      }
    }
  }
  const snapshot = {
    schemaVersion: 1,
    privacy: "Exact aggregate retention cells only; protocol identities remain namespaced and no identifiers are included.",
    protocol: "all",
    sourceKeys: [...new Set([...mpp.sourceKeys, ...x402.sourceKeys])].sort(),
    coverageStart: [mpp.coverageStart, x402.coverageStart].sort()[0],
    coverageEnd: [mpp.coverageEnd, x402.coverageEnd].sort().at(-1),
    completeThrough,
    cells: [...cells.values()].sort((left, right) => cellKey(left).localeCompare(cellKey(right))),
  };
  const output = resolve(options.output);
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    cells: snapshot.cells.length,
    completeThrough,
    ingestion: await ingest(snapshot, options),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
