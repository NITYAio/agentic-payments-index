import assert from "node:assert/strict";
import test from "node:test";

import { aggregateIdentityActivity } from "../lib/identity-data.ts";

test("aggregates events by hashed identity, role, and month", async () => {
  const activity = await aggregateIdentityActivity("segment-1", [
    {
      id: "tx-1",
      protocol: "x402",
      network: "eip155:8453",
      occurredAt: "2026-01-05T12:00:00.000Z",
      payer: { scheme: "evm", key: "0x1111111111111111111111111111111111111111" },
      payee: { scheme: "evm", key: "0x2222222222222222222222222222222222222222" },
      transactionCount: 1,
      volumeUsdMicros: 10_000,
      evidenceLevel: "verified",
    },
    {
      id: "tx-2",
      protocol: "x402",
      network: "EIP155:8453",
      occurredAt: "2026-01-20T12:00:00.000Z",
      payer: { scheme: "EVM", key: "0x1111111111111111111111111111111111111111" },
      payee: { scheme: "evm", key: "0x2222222222222222222222222222222222222222" },
      transactionCount: 2,
      volumeUsdMicros: 25_000,
      evidenceLevel: "verified",
    },
    {
      id: "tx-3",
      protocol: "x402",
      network: "eip155:8453",
      occurredAt: "2026-02-01T00:00:00.000Z",
      payer: { scheme: "evm", key: "0x1111111111111111111111111111111111111111" },
      payee: { scheme: "evm", key: "0x2222222222222222222222222222222222222222" },
      volumeUsdMicros: 5_000,
      evidenceLevel: "verified",
    },
  ]);
  assert.equal(activity.length, 4);
  const januaryPayer = activity.find(
    (row) => row.role === "payer" && row.activityMonth === "2026-01",
  );
  assert.equal(januaryPayer.transactionCount, 3);
  assert.equal(januaryPayer.volumeUsdMicros, 35_000);
  assert.equal(januaryPayer.identityHash.length, 64);
  assert.equal(JSON.stringify(activity).includes("0x1111111111111111111111111111111111111111"), false);
});
