import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_USDC_ADDRESS,
  concentrationSummary,
  createIndexedIdentityAccumulator,
  mergeConcentration,
  normalizedIndexedPayment,
  verifyIndexedPaymentReceipt,
} from "../scripts/lib/x402-index-feed.mjs";

const payer = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;

function payment(overrides = {}) {
  return {
    id: "row-1",
    address: BASE_USDC_ADDRESS,
    token_address: BASE_USDC_ADDRESS,
    sender: payer,
    recipient,
    amount: 1_250_000,
    decimals: 6,
    block_timestamp: "2026-08-18T12:00:00.000Z",
    tx_hash: hash,
    ...overrides,
  };
}

test("hashes indexed payer and terminal recipient identities without retaining addresses", () => {
  const accumulator = createIndexedIdentityAccumulator();
  accumulator.consume(payment());
  const result = accumulator.result();
  assert.equal(result.indexedRows, 1);
  assert.equal(result.activities.length, 2);
  assert.ok(result.activities.every((row) => row.volumeUsdMicros === 1_250_000));
  assert.equal(JSON.stringify(result).includes(payer), false);
  assert.equal(JSON.stringify(result).includes(recipient), false);
});

test("excludes non-USDC rows from the stablecoin identity backfill", () => {
  const accumulator = createIndexedIdentityAccumulator();
  accumulator.consume(payment({ token_address: "0x3333333333333333333333333333333333333333" }));
  const result = accumulator.result();
  assert.equal(result.indexedRows, 0);
  assert.equal(result.excludedNonUsdc, 1);
});

test("verifies payer and terminal recipient against receipt transfer logs", () => {
  const normalized = normalizedIndexedPayment(payment());
  const topic = (address) => `0x${address.slice(2).padStart(64, "0")}`;
  const receipt = {
    status: "0x1",
    logs: [{
      address: BASE_USDC_ADDRESS,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        topic(payer),
        topic(recipient),
      ],
      data: "0x1312d0",
    }],
  };
  assert.equal(verifyIndexedPaymentReceipt(normalized, receipt).verified, true);
});

test("computes buyer concentration without exposing identity keys", () => {
  const payers = new Map();
  const first = normalizedIndexedPayment(payment());
  const second = normalizedIndexedPayment(payment({ sender: "0x4444444444444444444444444444444444444444", amount: 250_000 }));
  mergeConcentration(payers, first);
  mergeConcentration(payers, first);
  mergeConcentration(payers, second);
  const summary = concentrationSummary(payers);
  assert.equal(summary.uniquePayers, 2);
  assert.equal(summary.top1VolumeSharePct, 90.909);
  assert.equal(summary.top2TransactionSharePct, 100);
  assert.equal(JSON.stringify(summary).includes(payer), false);
});
