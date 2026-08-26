#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const DEFAULT_FROM = "2025-05-09T00:00:00.000Z";

function argumentsFrom(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--prefer-tempo-derived") options.preferTempoDerived = true;
    else if (value === "--prefer-tempo-derived-logs") options.preferTempoDerivedLogs = true;
    else if (value === "--repair-missing-distribution") {
      options.repairMissingDistribution = true;
    }
    else if (value.startsWith("--")) {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else throw new Error(`Unexpected argument: ${value}`);
  }
  return options;
}

function utcStartOfDay(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function safeTimestamp(value) {
  return value.toISOString().replaceAll(":", "-");
}

function slicesBetween(from, to, hours) {
  const slices = [];
  const step = hours * 3_600_000;
  for (let cursor = from.getTime(); cursor < to.getTime(); cursor += step) {
    slices.push({
      from: new Date(cursor),
      to: new Date(Math.min(cursor + step, to.getTime())),
    });
  }
  return slices;
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function runCollector(args) {
  return new Promise((resolveRun, rejectRun) => {
    const quiet = args.includes("--quiet");
    const child = spawn(process.execPath, [
      "--env-file-if-exists=.env.local",
      "scripts/collect-identity-history.mjs",
      ...args,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveRun(stdout);
      else {
        const error = new Error(
          `x402 event collector exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
        );
        error.output = stderr.slice(-2_000);
        rejectRun(error);
      }
    });
  });
}

async function manifestIn(directory) {
  const names = await readdir(directory);
  const name = names.find((entry) => entry.endsWith("-manifest.json"));
  if (!name) throw new Error(`No identity manifest was written in ${directory}.`);
  return resolve(directory, name);
}

function consolidatedManifest(outputDir, state) {
  const completed = state.completed
    .toSorted((left, right) => left.from.localeCompare(right.from))
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      manifest: entry.manifest,
      completedAt: entry.completedAt,
    }));
  return {
    schemaVersion: 2,
    privacy: "Contains SHA-256 identity hashes only; raw identity keys are never written.",
    protocol: "x402",
    rangeStart: state.from,
    rangeEnd: completed.at(-1)?.to ?? state.from,
    sliceManifests: completed.map((entry) => entry.manifest),
    checkpoint: {
      requestedRangeEnd: state.to,
      completedSlices: completed.length,
      totalSlices: state.totalSlices,
      complete: completed.length === state.totalSlices,
      updatedAt: new Date().toISOString(),
    },
  };
}

function hasTrustDistribution(entry) {
  return (
    Array.isArray(entry?.data?.summaries) &&
    entry.data.summaries.length > 0 &&
    entry.data.summaries.every((summary) => {
      const collection = summary?.collection;
      return (
        Array.isArray(collection?.windowSummary?.trustAmountHistogram) &&
        Array.isArray(collection?.metrics) &&
        collection.metrics.every((metric) => Array.isArray(metric.trustAmountHistogram))
      );
    })
  );
}

function compactCompletedEntry(entry) {
  return {
    from: entry.from,
    to: entry.to,
    directory: entry.directory,
    manifest: entry.manifest,
    trustDistributionVerified:
      entry.trustDistributionVerified === true || hasTrustDistribution(entry),
    completedAt: entry.completedAt,
  };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const source = options.source ?? "events";
  if (!new Set(["events", "blockscout", "sqd"]).has(source)) {
    throw new Error("--source must be events, blockscout, or sqd.");
  }
  const from = new Date(options.from ?? DEFAULT_FROM);
  const to = new Date(options.to ?? utcStartOfDay().toISOString());
  const sliceHours = Number.parseInt(options["slice-hours"] ?? "2", 10);
  const maxSlices = Number.parseInt(options["max-slices"] ?? String(Number.MAX_SAFE_INTEGER), 10);
  const retries = Number.parseInt(options.retries ?? "3", 10);
  const sliceConcurrency = Number.parseInt(options["slice-concurrency"] ?? "1", 10);
  const providerStrategy = options["provider-strategy"] ??
    (options.preferTempoDerived ? "drpc" : "quicknode");
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error("--from and --to must define a valid increasing UTC range.");
  }
  if (!Number.isSafeInteger(sliceHours) || sliceHours < 1 || sliceHours > 24) {
    throw new Error("--slice-hours must be an integer between 1 and 24.");
  }
  if (!Number.isSafeInteger(maxSlices) || maxSlices < 1) {
    throw new Error("--max-slices must be a positive integer.");
  }
  if (!Number.isSafeInteger(retries) || retries < 1 || retries > 10) {
    throw new Error("--retries must be an integer between 1 and 10.");
  }
  if (!Number.isSafeInteger(sliceConcurrency) || sliceConcurrency < 1 || sliceConcurrency > 8) {
    throw new Error("--slice-concurrency must be an integer between 1 and 8.");
  }
  if (!new Set(["drpc", "quicknode", "alternating"]).has(providerStrategy)) {
    throw new Error("--provider-strategy must be drpc, quicknode, or alternating.");
  }

  const outputDir = resolve(options["output-dir"] ?? "/private/tmp/api-identity-backfill-x402-events");
  const statePath = resolve(outputDir, "backfill-state.json");
  const manifestPath = resolve(outputDir, "x402-event-history-manifest.json");
  await mkdir(outputDir, { recursive: true });
  const slices = slicesBetween(from, to, sliceHours);
  const existing = await readJson(statePath);
  const state = existing ?? {
    schemaVersion: 1,
    protocol: "x402",
    source:
      source === "blockscout"
        ? "identity:x402:base-usdc:blockscout:terminal-recipient-v1"
        : source === "sqd"
          ? "identity:x402:base-usdc:sqd-portal:terminal-recipient-v1"
        : "identity:x402:base-usdc:rpc-events:terminal-recipient-v1",
    collectorSource: source,
    from: from.toISOString(),
    to: to.toISOString(),
    sliceHours,
    totalSlices: slices.length,
    completed: [],
    failures: [],
    startedAt: new Date().toISOString(),
  };
  if (
    state.from !== from.toISOString() ||
    state.sliceHours !== sliceHours ||
    (state.collectorSource ?? "events") !== source
  ) {
    throw new Error("Existing checkpoint range differs from this run. Use another --output-dir.");
  }
  const previousTo = new Date(state.to);
  if (to < previousTo) {
    throw new Error("The requested end precedes the existing checkpoint end. Use another --output-dir.");
  }
  if (to > previousTo) {
    const sliceMilliseconds = sliceHours * 3_600_000;
    if ((previousTo.getTime() - from.getTime()) % sliceMilliseconds !== 0) {
      throw new Error("The existing checkpoint end is not aligned to the requested slice size.");
    }
    state.to = to.toISOString();
    state.totalSlices = slices.length;
  }

  // Older checkpoints embedded every daily manifest, including its exact ticket-size
  // histogram. Keep those immutable daily manifests on disk and checkpoint references
  // only; otherwise a long history eventually exceeds V8's maximum JSON string size.
  const checkpointWasExpanded = state.completed.some((entry) => entry.data);
  if (checkpointWasExpanded || state.schemaVersion !== 2) {
    state.schemaVersion = 2;
    state.completed = state.completed.map(compactCompletedEntry);
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
  }

  if (options.repairMissingDistribution) {
    const before = state.completed.length;
    const repaired = [];
    for (const entry of state.completed) {
      const data = await readJson(resolve(outputDir, entry.manifest));
      if (hasTrustDistribution({ data })) {
        repaired.push({ ...entry, trustDistributionVerified: true });
      }
    }
    state.completed = repaired;
    const removed = before - state.completed.length;
    if (removed > 0) {
      process.stderr.write(
        `Repairing ${removed} completed slices that predate exact ticket-size distributions.\n`,
      );
      await writeJsonAtomic(statePath, state);
      await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
    }
  }

  const completedKeys = new Set(state.completed.map((entry) => `${entry.from}|${entry.to}`));

  // A collector writes its daily manifest before the parent checkpoint. Recover any
  // such completed slices after an interrupted or oversized checkpoint write.
  for (const slice of slices) {
    const fromIso = slice.from.toISOString();
    const toIso = slice.to.toISOString();
    const key = `${fromIso}|${toIso}`;
    if (completedKeys.has(key)) continue;
    const directory = resolve(outputDir, `${safeTimestamp(slice.from)}_${safeTimestamp(slice.to)}`);
    try {
      const manifest = await manifestIn(directory);
      const data = await readJson(manifest);
      if (!hasTrustDistribution({ data })) continue;
      state.completed.push({
        from: fromIso,
        to: toIso,
        directory,
        manifest: relative(outputDir, manifest),
        trustDistributionVerified: true,
        completedAt: new Date().toISOString(),
      });
      completedKeys.add(key);
      process.stderr.write(`Recovered completed slice ${fromIso} → ${toIso}.\n`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Directories without a final manifest are incomplete and will be recollected.
        if (!String(error?.message ?? "").startsWith("No identity manifest")) throw error;
      }
    }
  }
  if (completedKeys.size !== state.completed.length || state.completed.length > 0) {
    state.completed = state.completed.toSorted((left, right) => left.from.localeCompare(right.from));
    await writeJsonAtomic(statePath, state);
    await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
  }

  const jobs = [];
  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
    const slice = slices[sliceIndex];
    const fromIso = slice.from.toISOString();
    const toIso = slice.to.toISOString();
    const key = `${fromIso}|${toIso}`;
    if (completedKeys.has(key)) continue;
    if (jobs.length >= maxSlices) break;
    jobs.push({ ...slice, sliceIndex, fromIso, toIso });
  }

  let checkpointQueue = Promise.resolve();
  function checkpoint() {
    checkpointQueue = checkpointQueue.then(async () => {
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
    });
    return checkpointQueue;
  }

  function shouldUseDrpc(job) {
    return providerStrategy === "drpc" ||
      (providerStrategy === "alternating" && job.sliceIndex % 2 === 0);
  }

  async function processSlice(job) {
    const { sliceIndex, fromIso, toIso } = job;
    const directory = resolve(outputDir, `${safeTimestamp(job.from)}_${safeTimestamp(job.to)}`);
    await mkdir(directory, { recursive: true });
    const provider = source === "events" ? (shouldUseDrpc(job) ? "dRPC" : "QuickNode") : source;
    process.stderr.write(
      `\nBackfilling x402 identities ${fromIso} → ${toIso} ` +
        `(slice ${sliceIndex + 1}/${slices.length}, ${provider})\n`,
    );
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await runCollector([
          "--protocol", "x402",
          "--source", source,
          "--from", fromIso,
          "--to", toIso,
          ...(source === "events"
            ? [
                "--event-chunk-size", options["event-chunk-size"] ?? "10000",
                "--block-batch-size", options["block-batch-size"] ?? "3",
                "--receipt-mode", options["receipt-mode"] ?? "transaction-filter",
                "--rpc-concurrency", options["rpc-concurrency"] ?? "4",
                "--rpc-delay-ms", options["rpc-delay-ms"] ?? "25",
                "--log-rpc-delay-ms", options["log-rpc-delay-ms"] ?? "25",
                "--rpc-max-attempts", options["rpc-max-attempts"] ?? "8",
              ]
            : source === "blockscout"
              ? [
                "--blockscout-delay-ms", options["blockscout-delay-ms"] ?? "400",
                "--blockscout-concurrency", options["blockscout-concurrency"] ?? "2",
              ]
              : [
                  "--sqd-portal", options["sqd-portal"] ?? "https://portal.sqd.dev/datasets/base-mainnet",
                  "--rpc-delay-ms", options["rpc-delay-ms"] ?? "25",
                  "--rpc-max-attempts", options["rpc-max-attempts"] ?? "8",
                  "--quiet",
                ]),
          ...(source === "events" && shouldUseDrpc(job) ? ["--prefer-tempo-derived"] : []),
          ...(source === "events" &&
          (options.preferTempoDerivedLogs === true || providerStrategy === "alternating")
            ? ["--prefer-tempo-derived-logs"]
            : []),
          "--no-ingest",
          "--output-dir", directory,
        ]);
        const manifest = await manifestIn(directory);
        const data = await readJson(manifest);
        if (!hasTrustDistribution({ data })) {
          throw new Error(`Identity manifest lacks an exact ticket-size distribution: ${manifest}`);
        }
        state.completed.push({
          from: fromIso,
          to: toIso,
          directory,
          manifest: relative(outputDir, manifest),
          trustDistributionVerified: true,
          completedAt: new Date().toISOString(),
        });
        await checkpoint();
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        process.stderr.write(
          `Slice attempt ${attempt}/${retries} failed: ${error.message}\n${error.output ?? ""}\n`,
        );
        if (attempt < retries) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5_000 * attempt));
        }
      }
    }
    if (lastError) {
      state.failures.push({
        from: fromIso,
        to: toIso,
        message: lastError.message,
        output: lastError.output ?? null,
        failedAt: new Date().toISOString(),
      });
      await checkpoint();
      throw lastError;
    }
  }

  let nextJob = 0;
  const workerErrors = [];
  async function worker() {
    while (nextJob < jobs.length && workerErrors.length === 0) {
      const jobIndex = nextJob;
      nextJob += 1;
      try {
        await processSlice(jobs[jobIndex]);
      } catch (error) {
        workerErrors.push(error);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(sliceConcurrency, jobs.length) }, () => worker()),
  );
  await checkpointQueue;
  if (workerErrors.length) throw workerErrors[0];

  const manifest = consolidatedManifest(outputDir, state);
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({ statePath, manifestPath, ...manifest.checkpoint }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exitCode = 1;
});
