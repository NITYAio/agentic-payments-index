import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubstreamsIdentityAccumulator,
  settlementsFromJsonLine,
} from "../scripts/lib/x402-substreams.mjs";

const payer = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";

test("finds settlements in Substreams JSONL envelopes", () => {
  const envelope = settlementsFromJsonLine(JSON.stringify({
    data: {
      "@module": "map_x402_settlements",
      blockTimestamp: "2026-08-18T12:00:00.000Z",
      settlements: [{ id: "tx-1", payer, recipient, amount: "1250000" }],
    },
  }));
  assert.equal(envelope.settlements.length, 1);
  assert.equal(envelope.blockTimestamp, "2026-08-18T12:00:00.000Z");
});

test("hashes identities, deduplicates settlements, and preserves terminal payment value", () => {
  const accumulator = createSubstreamsIdentityAccumulator({
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
  });
  const envelope = {
    blockTimestamp: "2026-08-18T12:00:00.000Z",
    settlements: [{ id: "tx-1", payer, recipient, amount: "1250000" }],
  };
  accumulator.consume(envelope);
  accumulator.consume(envelope);
  const result = accumulator.result();
  assert.equal(result.settlementCount, 1);
  assert.equal(result.activities.length, 2);
  assert.deepEqual(result.activities.map((row) => row.role).sort(), ["payee", "payer"]);
  assert.ok(result.activities.every((row) => row.transactionCount === 1));
  assert.ok(result.activities.every((row) => row.volumeUsdMicros === 1_250_000));
  assert.equal(JSON.stringify(result).includes(payer), false);
  assert.equal(JSON.stringify(result).includes(recipient), false);
});

test("rejects out-of-window and malformed rows without writing raw identities", () => {
  const accumulator = createSubstreamsIdentityAccumulator({
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
  });
  accumulator.consume({
    blockTimestamp: "2026-07-31T23:59:59.000Z",
    settlements: [{ id: "old", payer, recipient, amount: "1" }],
  });
  accumulator.consume({
    blockTimestamp: "2026-08-10T00:00:00.000Z",
    settlements: [{ id: "bad", payer: "not-an-address", recipient: "", amount: "wat" }],
  });
  const result = accumulator.result();
  assert.equal(result.activities.length, 0);
  assert.equal(result.skippedOutsideRange, 1);
  assert.equal(result.skippedInvalid, 1);
});
