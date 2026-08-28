import type {
  CohortMode,
  CohortProtocol,
  CohortRole,
} from "./cohort-analysis";

export type CohortSnapshotCellInput = {
  role: CohortRole;
  mode: CohortMode;
  cohortMonth: string;
  offset: number;
  calendarMonth: string;
  cohortSize: number;
  retained: number;
  leftCensored: boolean;
};

export type CohortSnapshotInput = {
  protocol: CohortProtocol;
  sourceKeys: string[];
  coverageStart: string;
  coverageEnd: string;
  completeThrough: string;
  cells: CohortSnapshotCellInput[];
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9:._/-]+$/;

function monthIndex(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

function monthFromIndex(index: number) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function timestamp(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} is invalid.`);
  return date.toISOString();
}

function count(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return Number(value);
}

export function validateCohortSnapshot(value: unknown): CohortSnapshotInput {
  if (!value || typeof value !== "object") throw new Error("Snapshot body is required.");
  const body = value as Record<string, unknown>;
  const protocol =
    body.protocol === "all" || body.protocol === "mpp" || body.protocol === "x402"
      ? body.protocol
      : null;
  if (!protocol) throw new Error("Protocol must be all, MPP, or x402.");
  if (!Array.isArray(body.sourceKeys) || body.sourceKeys.length < 1 || body.sourceKeys.length > 10) {
    throw new Error("One to ten source keys are required.");
  }
  const sourceKeys = [...new Set(body.sourceKeys.map((sourceKey) => {
    if (
      typeof sourceKey !== "string" ||
      !sourceKey.trim() ||
      sourceKey.length > 120 ||
      !SOURCE_KEY_PATTERN.test(sourceKey)
    ) {
      throw new Error("A source key is invalid.");
    }
    return sourceKey.trim();
  }))].sort();
  const coverageStart = timestamp(body.coverageStart, "Coverage start");
  const coverageEnd = timestamp(body.coverageEnd, "Coverage end");
  if (coverageStart >= coverageEnd) throw new Error("Coverage end must follow coverage start.");
  if (typeof body.completeThrough !== "string" || !MONTH_PATTERN.test(body.completeThrough)) {
    throw new Error("Complete through must use YYYY-MM.");
  }
  const completeThrough = body.completeThrough;
  if (!Array.isArray(body.cells) || body.cells.length < 1 || body.cells.length > 5_000) {
    throw new Error("A snapshot must contain between 1 and 5,000 cells.");
  }
  const cells = body.cells.map((cellValue, index) => {
    if (!cellValue || typeof cellValue !== "object") {
      throw new Error(`Cell ${index + 1} is invalid.`);
    }
    const cell = cellValue as Record<string, unknown>;
    const role = cell.role === "payer" || cell.role === "payee" ? cell.role : null;
    const mode = cell.mode === "activity" || cell.mode === "acquisition" ? cell.mode : null;
    if (!role || !mode) throw new Error(`Cell ${index + 1} has an invalid role or mode.`);
    if (typeof cell.cohortMonth !== "string" || !MONTH_PATTERN.test(cell.cohortMonth)) {
      throw new Error(`Cell ${index + 1} has an invalid cohort month.`);
    }
    const offset = count(cell.offset, `Cell ${index + 1} offset`);
    if (offset > 24) throw new Error(`Cell ${index + 1} offset exceeds 24 months.`);
    const calendarMonth = monthFromIndex(monthIndex(cell.cohortMonth) + offset);
    if (cell.calendarMonth !== calendarMonth) {
      throw new Error(`Cell ${index + 1} calendar month does not match its offset.`);
    }
    const cohortSize = count(cell.cohortSize, `Cell ${index + 1} cohort size`);
    const retained = count(cell.retained, `Cell ${index + 1} retained count`);
    if (retained > cohortSize) throw new Error(`Cell ${index + 1} retained count exceeds cohort size.`);
    if (offset === 0 && retained !== cohortSize) {
      throw new Error(`Cell ${index + 1} must retain the full cohort at M+0.`);
    }
    if (typeof cell.leftCensored !== "boolean") {
      throw new Error(`Cell ${index + 1} left-censored flag is invalid.`);
    }
    return {
      role,
      mode,
      cohortMonth: cell.cohortMonth,
      offset,
      calendarMonth,
      cohortSize,
      retained,
      leftCensored: cell.leftCensored,
    };
  });
  const keys = cells.map((cell) =>
    [cell.role, cell.mode, cell.cohortMonth, cell.offset].join("|"),
  );
  if (new Set(keys).size !== keys.length) throw new Error("Snapshot cell keys must be unique.");
  if (cells.some((cell) => monthIndex(cell.calendarMonth) > monthIndex(completeThrough))) {
    throw new Error("Snapshot cells extend beyond the complete-through month.");
  }
  return {
    protocol,
    sourceKeys,
    coverageStart,
    coverageEnd,
    completeThrough,
    cells,
  };
}
