/**
 * Origin checking, rate limiting and bot detection for public endpoints.
 *
 * Embedded forms and public booking pages are unauthenticated by necessity —
 * they are pasted into other people's web pages — so these are the only thing
 * between a customer's data and the open internet. Shared here because every
 * module that opens a public endpoint needs the same three guards, and a second
 * implementation is a second set of mistakes.
 */

export interface OriginDecision {
  allowed: boolean;
  /** Value for Access-Control-Allow-Origin, when allowed. */
  echo?: string;
}

/**
 * A form declares the domains permitted to post to it. The public form key is
 * visible in page source, so without this anyone could lift it and submit from
 * anywhere; the origin list is what makes the key worth something.
 *
 * An empty list means same-origin only — a form that has not been told where it
 * will live should not accept cross-site posts.
 */
export function originAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
): OriginDecision {
  if (!origin) return { allowed: true }; // same-origin or a non-browser client
  if (allowedOrigins.length === 0) return { allowed: false };

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return { allowed: false };
  }

  for (const entry of allowedOrigins) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;

    // accept a bare host, a full origin, or a leading-wildcard subdomain
    const patternHost = pattern.includes("://")
      ? safeHost(pattern)
      : pattern.replace(/\/.*$/, "");
    if (!patternHost) continue;

    if (patternHost.startsWith("*.")) {
      const base = patternHost.slice(2);
      if (host === base || host.endsWith(`.${base}`)) {
        return { allowed: true, echo: origin };
      }
      continue;
    }
    if (host === patternHost) return { allowed: true, echo: origin };
  }
  return { allowed: false };
}

function safeHost(value: string): string | undefined {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Sliding-window rate limit, per key, in memory.
 *
 * ponytail: single-process only. One app container is the shipped topology, so
 * this is enough; move it into Postgres or Redis if the host is ever scaled out,
 * or the limit becomes per-process rather than per-instance.
 */
const hits = new Map<string, number[]>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);

  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    hits.set(key, recent);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowMs - (now - oldest)) / 1000),
      ),
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // keep the map from growing without bound on a long-lived process
  if (hits.size > 10_000) {
    for (const [k, times] of hits) {
      if (times.every((at) => now - at >= windowMs)) hits.delete(k);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetRateLimits() {
  hits.clear();
}

/** The field bots fill in and humans never see. */
export const HONEYPOT_FIELD = "_sentrello_hp";

/** CORS headers for an allowed origin; nothing at all for a refused one. */
export function corsHeaders(
  origin: string | undefined,
): Record<string, string> {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function looksAutomated(payload: Record<string, unknown>): boolean {
  const trap = payload[HONEYPOT_FIELD];
  return typeof trap === "string" && trap.trim() !== "";
}
