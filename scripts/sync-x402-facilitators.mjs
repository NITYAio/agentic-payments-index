#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function baseArray(source, file) {
  const marker = "[Network.BASE]";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const open = source.indexOf("[", source.indexOf(":", markerIndex));
  if (open < 0) throw new Error(`Could not locate Base address array in ${file}.`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Base address array is not balanced in ${file}.`);
}

function objectsInArray(source) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function requiredMatch(source, pattern, label, file) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not read ${label} from ${file}.`);
  return match[1];
}

async function main() {
  const sourceDirectory = process.argv[2];
  if (!sourceDirectory) {
    throw new Error(
      "Usage: node scripts/sync-x402-facilitators.mjs /path/to/facilitators/src/facilitators",
    );
  }
  const directory = resolve(sourceDirectory);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".ts") && file !== "index.ts" && file !== "auto.ts")
    .sort();
  const entries = [];
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    const array = baseArray(source, file);
    if (!array) continue;
    const facilitatorId = requiredMatch(source, /\bid:\s*'([^']+)'/, "facilitator id", file);
    const facilitatorName = requiredMatch(source, /\bname:\s*'([^']+)'/, "facilitator name", file);
    const docsUrl = requiredMatch(source, /\bdocsUrl:\s*'([^']+)'/, "docs URL", file);
    for (const object of objectsInArray(array)) {
      const address = object.match(/\baddress:\s*'([^']+)'/)?.[1]?.toLowerCase();
      if (!address) continue;
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        throw new Error(`Invalid Base address in ${file}: ${address}`);
      }
      const firstSeen = object.match(/dateOfFirstTransaction:\s*new Date\('([^']+)'\)/)?.[1];
      if (!firstSeen) throw new Error(`Missing first transaction date for ${address} in ${file}.`);
      entries.push({
        facilitatorId,
        facilitatorName,
        address,
        tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        firstSeen,
        deprecated: /\bdeprecated:\s*true/.test(object),
        docsUrl,
      });
    }
  }
  entries.sort((left, right) =>
    left.facilitatorId.localeCompare(right.facilitatorId) || left.address.localeCompare(right.address),
  );
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.address;
    if (seen.has(key)) throw new Error(`Duplicate Base facilitator address: ${key}`);
    seen.add(key);
  }
  const result = {
    schemaVersion: 1,
    network: "base",
    asset: "USDC",
    source: "https://github.com/Merit-Systems/x402scan/tree/main/packages/external/facilitators",
    sourcePackageVersion: "0.0.10",
    sourceLicense: "MIT",
    generatedAt: new Date().toISOString(),
    note: "Open facilitator metadata only. Transaction activity is read independently from Base chain data.",
    entries,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(
    `Read ${entries.length} Base-USDC addresses across ${new Set(entries.map((entry) => entry.facilitatorId)).size} facilitators from ${basename(directory)}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
