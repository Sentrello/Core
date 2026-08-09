import type { SentrelloEnv, SentrelloSession } from "@sentrello/module-sdk";
import type { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth } from "./index";

export type Session = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

/** The Hono environment every Sentrello route runs in. */
export type AppEnv = SentrelloEnv;

export function mountAuth(app: Hono<AppEnv>) {
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}

/** Route guard: requires a session, attaches it to context. */
export function requireSession() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("session", session as SentrelloSession);
    await next();
  });
}

/**
 * Permission guard: e.g. requirePermission({ invoicing: ["send"] }).
 *
 * `auth.api.hasPermission` resolves to `{ error, success }`, never a bare
 * boolean — truthiness-testing the response would let every check pass, so the
 * `success` flag is read explicitly and anything else denies.
 */
export function requirePermission(permissions: Record<string, string[]>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let granted = false;
    try {
      const result = await auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: { permissions },
      });
      granted = result?.success === true;
    } catch {
      granted = false; // not a member, no active org, malformed request
    }
    if (!granted) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}

/**
 * The organization every business query must be scoped by. Throws rather than
 * returning undefined: a business query that silently loses its org filter is
 * a cross-tenant data leak.
 */
export function activeOrganizationId(session: SentrelloSession): string {
  const orgId = session.session.activeOrganizationId;
  if (!orgId) throw new Error("session has no active organization");
  return orgId;
}
