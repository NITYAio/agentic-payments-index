import assert from "node:assert/strict";
import test from "node:test";

import {
  asksForChange,
  classifyQuery,
  protocolForQuery,
  windowForQuery,
} from "../lib/query-intent.ts";

const intentCases = [
  ["What is the avg transaction size in USD for the past 24 hrs and how has it changed in the last 30 days?", "average_payment"],
  ["Compare MPP and x402 growth over 30 days", "growth"],
  ["What share does MPP have versus x402?", "protocol_comparison"],
  ["Why did MPP transactions spike on July 27?", "anomaly"],
  ["Show buyer cohort retention over the past 12 months", "cohort"],
  ["Which wallet providers are used for these payments?", "wallet"],
  ["How many payments were made autonomously by agents?", "autonomy"],
  ["Which services led today?", "top_service"],
  ["How many agents paid this week?", "payer_addresses"],
  ["How many active recipient identities were there?", "server_identities"],
  ["Show USD volume", "volume"],
  ["How many transactions happened?", "transactions"],
];

for (const [question, expected] of intentCases) {
  test(`classifies: ${question}`, () => {
    assert.equal(classifyQuery(question), expected);
  });
}

test("explicit protocol names override the selected tab", () => {
  assert.equal(protocolForQuery("Show MPP volume", "x402"), "mpp");
  assert.equal(protocolForQuery("Compare MPP and x402", "mpp"), "all");
  assert.equal(protocolForQuery("Show volume", "x402"), "x402");
});

test("extracts every supported time window without confusing composite questions", () => {
  assert.equal(windowForQuery("past 24 hrs compared with 30 days", 30), 1);
  assert.equal(windowForQuery("over the last 7 days", 30), 7);
  assert.equal(windowForQuery("for the past 30 days", 1), 30);
  assert.equal(windowForQuery("since inception", 1), 0);
  assert.equal(windowForQuery("show the current view", 7), 7);
});

test("recognizes common comparison inflections", () => {
  for (const phrase of ["how has it changed", "compare this", "is it increasing", "what is the trend"]) {
    assert.equal(asksForChange(phrase), true, phrase);
  }
});
