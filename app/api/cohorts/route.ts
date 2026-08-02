import {
  type CohortMode,
  type CohortProtocol,
  type CohortRole,
} from "../../../lib/cohort-analysis";
import { loadCohortMatrix } from "../../../lib/cohort-store";

function cohortRole(value: string | null): CohortRole {
  return value === "payee" || value === "seller" || value === "service"
    ? "payee"
    : "payer";
}

function cohortProtocol(value: string | null): CohortProtocol {
  return value === "mpp" || value === "x402" ? value : "all";
}

function cohortMode(value: string | null): CohortMode {
  return value === "activity" ? "activity" : "acquisition";
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const months = Math.max(1, Math.min(24, Number(parameters.get("months") ?? 12) || 12));
    const cohortMonth = parameters.get("cohortMonth") ?? undefined;
    if (cohortMonth && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(cohortMonth)) {
      return Response.json({ error: "cohortMonth must use YYYY-MM." }, { status: 400 });
    }
    const matrix = await loadCohortMatrix({
      role: cohortRole(parameters.get("role")),
      protocol: cohortProtocol(parameters.get("protocol")),
      mode: cohortMode(parameters.get("mode")),
      months,
      cohortMonth,
    });
    return Response.json(matrix, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=300" },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Cohort analysis failed.",
      },
      { status: 503 },
    );
  }
}
