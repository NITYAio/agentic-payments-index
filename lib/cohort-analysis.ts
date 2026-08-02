export type CohortRole = "payer" | "payee";
export type CohortProtocol = "all" | "mpp" | "x402";
export type CohortMode = "activity" | "acquisition";

export type CohortActivityRow = {
  identityHash: string;
  activityMonth: string;
};

export type CohortRequest = {
  role: CohortRole;
  protocol: CohortProtocol;
  mode: CohortMode;
  months: number;
  cohortMonth?: string;
};

export type CohortCoverage = {
  start: string;
  end: string;
  sources: string[];
};

export type CohortCell = {
  offset: number;
  calendarMonth: string;
  retained: number;
  rate: number;
};

export type CohortRow = {
  cohortMonth: string;
  cohortSize: number;
  cells: CohortCell[];
  leftCensored: boolean;
};

export type CohortMatrix = {
  available: boolean;
  role: CohortRole;
  protocol: CohortProtocol;
  mode: CohortMode;
  rows: CohortRow[];
  columns: number[];
  coverageStart: string | null;
  coverageEnd: string | null;
  completeThrough: string | null;
  sources: string[];
  definition: string;
  limitation: string;
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthIndex(month: string) {
  if (!MONTH_PATTERN.test(month)) throw new Error(`Invalid month: ${month}`);
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber - 1;
}

export function monthFromIndex(index: number) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function previousCompleteMonth(now = new Date()) {
  return monthFromIndex(now.getUTCFullYear() * 12 + now.getUTCMonth() - 1);
}

function monthFromTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Coverage timestamp is invalid.");
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function activeIdentities(rows: CohortActivityRow[]) {
  const byMonth = new Map<string, Set<string>>();
  const firstMonth = new Map<string, string>();
  for (const row of rows) {
    if (!MONTH_PATTERN.test(row.activityMonth)) continue;
    const identities = byMonth.get(row.activityMonth) ?? new Set<string>();
    identities.add(row.identityHash);
    byMonth.set(row.activityMonth, identities);
    const previous = firstMonth.get(row.identityHash);
    if (!previous || row.activityMonth < previous) firstMonth.set(row.identityHash, row.activityMonth);
  }
  return { byMonth, firstMonth };
}

export function buildCohortMatrix(
  activityRows: CohortActivityRow[],
  request: CohortRequest,
  coverage: CohortCoverage | null,
  now = new Date(),
): CohortMatrix {
  const definition =
    request.mode === "acquisition"
      ? `An identity enters the cohort in its first observed active month and is retained when it pays again in a later month.`
      : `An identity enters the cohort when it is active in the selected month and is retained when it pays again in a later month.`;
  const empty: CohortMatrix = {
    available: false,
    role: request.role,
    protocol: request.protocol,
    mode: request.mode,
    rows: [],
    columns: [],
    coverageStart: coverage ? monthFromTimestamp(coverage.start) : null,
    coverageEnd: coverage ? monthFromTimestamp(coverage.end) : null,
    completeThrough: null,
    sources: coverage?.sources ?? [],
    definition,
    limitation:
      "Retention requires verified or deterministic identity history. Aggregate rolling counts are deliberately excluded.",
  };
  if (!coverage || activityRows.length === 0) return empty;

  const coverageStart = monthFromTimestamp(coverage.start);
  const coverageEnd = monthFromTimestamp(coverage.end);
  const completeThrough = monthFromIndex(
    Math.min(monthIndex(coverageEnd), monthIndex(previousCompleteMonth(now))),
  );
  const { byMonth, firstMonth } = activeIdentities(activityRows);
  const monthCount = Math.max(1, Math.min(24, Math.trunc(request.months)));
  const completeIndex = monthIndex(completeThrough);
  const requestedCohorts = request.cohortMonth
    ? [request.cohortMonth]
    : Array.from({ length: monthCount }, (_, offset) =>
        monthFromIndex(completeIndex - monthCount + 1 + offset),
      );
  const rows = requestedCohorts
    .filter((month) => monthIndex(month) <= completeIndex)
    .map((cohortMonth) => {
      const active = byMonth.get(cohortMonth) ?? new Set<string>();
      const members = new Set(
        [...active].filter(
          (identity) => request.mode === "activity" || firstMonth.get(identity) === cohortMonth,
        ),
      );
      const availableOffsets = Math.min(
        monthCount - 1,
        completeIndex - monthIndex(cohortMonth),
      );
      const cells = Array.from({ length: Math.max(0, availableOffsets) + 1 }, (_, offset) => {
        const calendarMonth = monthFromIndex(monthIndex(cohortMonth) + offset);
        const retained = [...members].filter((identity) =>
          byMonth.get(calendarMonth)?.has(identity),
        ).length;
        return {
          offset,
          calendarMonth,
          retained,
          rate: members.size ? (retained / members.size) * 100 : 0,
        };
      });
      return {
        cohortMonth,
        cohortSize: members.size,
        cells,
        leftCensored:
          request.mode === "acquisition" && cohortMonth <= coverageStart,
      };
    });
  const columns = Array.from(
    { length: Math.max(0, ...rows.map((row) => row.cells.length)) },
    (_, offset) => offset,
  );
  return {
    ...empty,
    available: rows.some((row) => row.cohortSize > 0),
    rows,
    columns,
    coverageStart,
    coverageEnd,
    completeThrough,
    limitation:
      request.protocol === "all"
        ? "Combined cohorts keep protocol and network identities separate; they are not cross-protocol deduplicated. The current partial month is excluded."
        : "Wallet or credential identities are not people; one actor can control several identities and several actors can share one. The current partial month is excluded.",
  };
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

export function parseCohortRequest(
  question: string,
  selectedProtocol: CohortProtocol,
  now = new Date(),
): CohortRequest {
  const text = question.toLowerCase();
  const monthMatch = text.match(
    new RegExp(`\\b(${MONTH_NAMES.join("|")}|${MONTH_NAMES.map((month) => month.slice(0, 3)).join("|")})\\.?\\s+(20\\d{2})\\b`),
  );
  let cohortMonth: string | undefined;
  if (monthMatch) {
    const month = MONTH_NAMES.findIndex(
      (name) => name === monthMatch[1] || name.startsWith(monthMatch[1]),
    );
    cohortMonth = `${monthMatch[2]}-${String(month + 1).padStart(2, "0")}`;
  }
  const duration = text.match(/\b(\d{1,2})\s*months?\b/);
  const complete = previousCompleteMonth(now);
  const months = cohortMonth
    ? Math.max(1, Math.min(24, monthIndex(complete) - monthIndex(cohortMonth) + 1))
    : Math.max(1, Math.min(24, duration ? Number(duration[1]) : 12));
  return {
    role: /\b(seller|service|server|recipient|payee)\b/.test(text) ? "payee" : "payer",
    protocol: selectedProtocol,
    mode: /\b(first|new|acquir|started|first-time)\b/.test(text)
      ? "acquisition"
      : monthMatch
        ? "activity"
        : "acquisition",
    months,
    cohortMonth,
  };
}
