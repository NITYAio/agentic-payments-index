import { getD1 } from "../db";

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

function requestIdentity(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "anonymous"
  );
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function checkPublicRateLimit(
  request: Request,
  route: string,
  options: { limit: number; windowSeconds: number },
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = options.windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;

  try {
    const d1 = await getD1();
    const clientHash = await sha256(`${route}:${requestIdentity(request)}`);
    const id = `${route}:${windowStart}:${clientHash}`;
    const updatedAt = new Date(now).toISOString();

    await d1
      .prepare(
        `INSERT INTO public_rate_limits
           (id, route, client_hash, window_start, request_count, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           request_count = request_count + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(id, route, clientHash, windowStart, updatedAt)
      .run();

    const row = await d1
      .prepare("SELECT request_count FROM public_rate_limits WHERE id = ?")
      .bind(id)
      .first<{ request_count: number }>();
    const count = Number(row?.request_count ?? 1);

    return {
      allowed: count <= options.limit,
      limit: options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt,
    };
  } catch {
    // Availability wins if the protective store is temporarily unavailable.
    return {
      allowed: true,
      limit: options.limit,
      remaining: options.limit,
      resetAt,
    };
  }
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
}
