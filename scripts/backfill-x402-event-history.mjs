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
      process.stderr.write(text);
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
  const completed = state.completed.map((entry) => ({
    ...entry,
    manifest: resolve(outputDir, entry.manifest),
  }));
  const segmentFiles = [];
  const summaries = [];
  for (const entry of completed) {
    for (const file of entry.data.segmentFiles) {
      segmentFiles.push(relative(outputDir, resolve(entry.directory, file)));
    }
    summaries.push(...entry.data.summaries.map((summary) => ({
      ...summary,
      sliceStart: entry.from,
      sliceEnd: entry.to,
    })));
  }
  return {
    schemaVersion: 1,
    privacy: "Contains SHA-256 identity hashes only; raw identity keys are never written.",
    protocol: "x402",
    rangeStart: state.from,
    rangeEnd: completed.at(-1)?.to ?? state.from,
    segmentFiles,
    summaries,
    checkpoint: {
      requestedRangeEnd: state.to,
      completedSlices: completed.length,
      totalSlices: state.totalSlices,
      complete: completed.length === state.totalSlices,
      updatedAt: new Date().toISOString(),
    },
  };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const from = new Date(options.from ?? DEFAULT_FROM);
  const to = new Date(options.to ?? utcStartOfDay().toISOString());
  const sliceHours = Number.parseInt(options["slice-hours"] ?? "2", 10);
  const maxSlices = Number.parseInt(options["max-slices"] ?? String(Number.MAX_SAFE_INTEGER), 10);
  const retries = Number.parseInt(options.retries ?? "3", 10);
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

  const outputDir = resolve(options["output-dir"] ?? "/private/tmp/api-identity-backfill-x402-events");
  const statePath = resolve(outputDir, "backfill-state.json");
  const manifestPath = resolve(outputDir, "x402-event-history-manifest.json");
  await mkdir(outputDir, { recursive: true });
  const slices = slicesBetween(from, to, sliceHours);
  const existing = await readJson(statePath);
  const state = existing ?? {
    schemaVersion: 1,
    protocol: "x402",
    source: "identity:x402:base-usdc:rpc-events:terminal-recipient-v1",
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
    state.to !== to.toISOString() ||
    state.sliceHours !== sliceHours
  ) {
    throw new Error("Existing checkpoint range differs from this run. Use another --output-dir.");
  }

  const completedKeys = new Set(state.completed.map((entry) => `${entry.from}|${entry.to}`));
  let processed = 0;
  for (const slice of slices) {
    const fromIso = slice.from.toISOString();
    const toIso = slice.to.toISOString();
    const key = `${fromIso}|${toIso}`;
    if (completedKeys.has(key)) continue;
    if (processed >= maxSlices) break;
    processed += 1;
    const directory = resolve(outputDir, `${safeTimestamp(slice.from)}_${safeTimestamp(slice.to)}`);
    await mkdir(directory, { recursive: true });
    process.stderr.write(
      `\nBackfilling x402 identities ${fromIso} → ${toIso} ` +
        `(slice ${state.completed.length + 1}/${slices.length})\n`,
    );
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await runCollector([
          "--protocol", "x402",
          "--source", "events",
          "--from", fromIso,
          "--to", toIso,
          "--event-chunk-size", options["event-chunk-size"] ?? "10000",
          "--block-batch-size", options["block-batch-size"] ?? "3",
          "--rpc-concurrency", options["rpc-concurrency"] ?? "4",
          "--rpc-delay-ms", options["rpc-delay-ms"] ?? "25",
          "--rpc-max-attempts", options["rpc-max-attempts"] ?? "8",
          ...(options.preferTempoDerived === false ? [] : ["--prefer-tempo-derived"]),
          "--no-ingest",
          "--output-dir", directory,
        ]);
        const manifest = await manifestIn(directory);
        const data = await readJson(manifest);
        state.completed.push({
          from: fromIso,
          to: toIso,
          directory,
          manifest: relative(outputDir, manifest),
          data,
          completedAt: new Date().toISOString(),
        });
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(statePath, state);
        await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
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
      state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(statePath, state);
      await writeJsonAtomic(manifestPath, consolidatedManifest(outputDir, state));
      throw lastError;
    }
  }

  const manifest = consolidatedManifest(outputDir, state);
  await writeJsonAtomic(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({ statePath, manifestPath, ...manifest.checkpoint }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exitCode = 1;
});
