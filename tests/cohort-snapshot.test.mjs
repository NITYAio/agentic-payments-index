import assert from "node:assert/strict";
import test from "node:test";

import { validateCohortSnapshot } from "../lib/cohort-snapshot.ts";

function validSnapshot() {
  return {
    protocol: "x402",
    sourceKeys: ["identity:x402:base-usdc:cdp-sql"],
    coverageStart: "2026-01-01T00:00:00.000Z",
    coverageEnd: "2026-03-01T00:00:00.000Z",
    completeThrough: "2026-02",
    cells: [
      {
        role: "payer",
        mode: "activity",
        cohortMonth: "2026-01",
        offset: 0,
        calendarMonth: "2026-01",
        cohortSize: 10,
        retained: 10,
        leftCensored: false,
      },
      {
        role: "payer",
        mode: "activity",
        cohortMonth: "2026-01",
        offset: 1,
        calendarMonth: "2026-02",
        cohortSize: 10,
        retained: 4,
        leftCensored: false,
      },
    ],
  };
}

test("accepts exact aggregate cohort cells without identities", () => {
  const snapshot = validateCohortSnapshot(validSnapshot());
  assert.equal(snapshot.protocol, "x402");
  assert.equal(snapshot.cells[1].retained, 4);
  assert.equal(JSON.stringify(snapshot).includes("identityHash"), false);
});

test("rejects inconsistent cohort offsets and counts", () => {
  const wrongMonth = validSnapshot();
  wrongMonth.cells[1].calendarMonth = "2026-03";
  assert.throws(() => validateCohortSnapshot(wrongMonth), /calendar month/);

  const wrongCount = validSnapshot();
  wrongCount.cells[1].retained = 11;
  assert.throws(() => validateCohortSnapshot(wrongCount), /exceeds cohort size/);
});

test("rejects duplicate cohort cell keys", () => {
  const duplicate = validSnapshot();
  duplicate.cells.push({ ...duplicate.cells[0] });
  assert.throws(() => validateCohortSnapshot(duplicate), /keys must be unique/);
});
