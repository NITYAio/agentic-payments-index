import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCohortMatrix,
  parseCohortRequest,
} from "../lib/cohort-analysis.ts";

const coverage = {
  start: "2025-12-01T00:00:00.000Z",
  end: "2026-04-30T23:59:59.000Z",
  sources: ["verified-test-source"],
};

const activity = [
  { identityHash: "a", activityMonth: "2025-12" },
  { identityHash: "a", activityMonth: "2026-01" },
  { identityHash: "b", activityMonth: "2026-01" },
  { identityHash: "c", activityMonth: "2026-01" },
  { identityHash: "a", activityMonth: "2026-02" },
  { identityHash: "b", activityMonth: "2026-02" },
  { identityHash: "a", activityMonth: "2026-03" },
];

test("calculates activity-cohort retention across completed months", () => {
  const matrix = buildCohortMatrix(
    activity,
    {
      role: "payer",
      protocol: "mpp",
      mode: "activity",
      months: 4,
      cohortMonth: "2026-01",
    },
    coverage,
    new Date("2026-05-15T00:00:00.000Z"),
  );
  assert.equal(matrix.available, true);
  assert.equal(matrix.completeThrough, "2026-04");
  assert.equal(matrix.rows[0].cohortSize, 3);
  assert.deepEqual(
    matrix.rows[0].cells.map((cell) => [cell.retained, Number(cell.rate.toFixed(1))]),
    [[3, 100], [2, 66.7], [1, 33.3], [0, 0]],
  );
});

test("acquisition cohorts exclude identities observed before the cohort month", () => {
  const matrix = buildCohortMatrix(
    activity,
    {
      role: "payer",
      protocol: "mpp",
      mode: "acquisition",
      months: 3,
      cohortMonth: "2026-01",
    },
    coverage,
    new Date("2026-05-15T00:00:00.000Z"),
  );
  assert.equal(matrix.rows[0].cohortSize, 2);
  assert.equal(matrix.rows[0].cells[1].retained, 1);
  assert.equal(matrix.rows[0].cells[1].rate, 50);
  assert.equal(matrix.rows[0].leftCensored, false);
});

test("marks first-month acquisition cohorts as left-censored", () => {
  const matrix = buildCohortMatrix(
    activity.filter((row) => row.activityMonth >= "2026-01"),
    {
      role: "payer",
      protocol: "all",
      mode: "acquisition",
      months: 2,
      cohortMonth: "2026-01",
    },
    { ...coverage, start: "2026-01-01T00:00:00.000Z" },
    new Date("2026-05-15T00:00:00.000Z"),
  );
  assert.equal(matrix.rows[0].leftCensored, true);
});

test("parses explicit activity cohorts and rolling acquisition cohorts", () => {
  const explicit = parseCohortRequest(
    "What is cohort retention for agents who made payments in Jan 2026?",
    "all",
    new Date("2026-08-02T00:00:00.000Z"),
  );
  assert.deepEqual(explicit, {
    role: "payer",
    protocol: "all",
    mode: "activity",
    months: 7,
    cohortMonth: "2026-01",
  });
  const rolling = parseCohortRequest(
    "Show first-time seller cohort retention over 12 months",
    "x402",
    new Date("2026-08-02T00:00:00.000Z"),
  );
  assert.equal(rolling.role, "payee");
  assert.equal(rolling.mode, "acquisition");
  assert.equal(rolling.months, 12);
});
