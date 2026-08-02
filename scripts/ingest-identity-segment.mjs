import { readFile } from "node:fs/promises";

const inputPath = process.argv[2];
const origin = (process.env.INDEX_ORIGIN ?? "https://agenticpaymentsindex.org").replace(/\/$/, "");
const token = process.env.IDENTITY_INGEST_TOKEN;

if (!inputPath) {
  throw new Error("Usage: npm run identity:ingest -- path/to/segment.json");
}
if (!token) {
  throw new Error("IDENTITY_INGEST_TOKEN is required.");
}

const body = await readFile(inputPath, "utf8");
JSON.parse(body);
const response = await fetch(`${origin}/api/internal/identity-ingest`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body,
});
const result = await response.json();
if (!response.ok) {
  throw new Error(result.error ?? `Ingestion failed with HTTP ${response.status}.`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
