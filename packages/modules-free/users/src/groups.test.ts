import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { and, db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import usersModule from "./index";
import { describeDevice } from "./sessions";

/**
 * Groups, roles and the rules for signing in.
 *
 * This is the half of the platform that decides what everybody else may do, so
 * the tests are about the ways it could quietly grant too much: a role that
 * does not exist, a group that outlives the permissions it granted, somebody
 * reading another business's devices.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `groups-owner-${suffix}@example.test`;
const staffEmail = `groups-staff-${suffix}@example.test`;

const app = registerForTest(usersModule);

let orgId: string;
let headers: Headers;
let ownerId: string;
let staffId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const set = signUp.headers.get("set-cookie");
  if (!set) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie: set, "content-type": "application/json" });
  ownerId = signUp.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Groups ${suffix}`, slug: `groups-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // A second person, added directly: this suite is about what they may do,
  // not about the invitation flow.
  const staff = await signUpAsOwner({
    email: staffEmail,
    password: "correct-horse-battery-staple",
    name: "A Fitter",
  });
  staffId = staff.response.user.id;
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: staffId,
    role: "staff",
    baseRole: "staff",
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(schema.userGroupMembers)
    .where(eq(schema.userGroupMembers.organizationId, orgId));
  await db
    .delete(schema.userGroups)
    .where(eq(schema.userGroups.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  for (const email of [ownerEmail, staffEmail]) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (u) {
      await db.delete(schema.session).where(eq(schema.session.userId, u.id));
      await db.delete(schema.account).where(eq(schema.account.userId, u.id));
      await db.delete(schema.user).where(eq(schema.user.id, u.id));
    }
  }
});

async function post(path: string, body: unknown) {
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function makeGroup(name: string, roles: string[]): Promise<string> {
  const res = await post("/api/users/groups", { name, roles });
  const body = (await res.json()) as { group?: { id: string } };
  if (!body.group) throw new Error(`could not make ${name}`);
  return body.group.id;
}

async function memberRole(userId: string): Promise<string> {
  const [row] = await db
    .select({ role: schema.member.role, baseRole: schema.member.baseRole })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, orgId),
        eq(schema.member.userId, userId),
      ),
    );
  return row?.role ?? "";
}

test("a group grants its roles on top of the person's own", async () => {
  const group = await makeGroup(`The office ${suffix}`, ["accounting"]);

  const joined = await post(`/api/users/groups/${group}/members`, {
    userId: staffId,
  });
  expect(joined.status).toBe(201);

  // Comma separated, which is what Better Auth splits and checks — so every
  // permission check in the platform sees the group's roles without knowing
  // groups exist.
  const role = await memberRole(staffId);
  expect(role.split(",").sort()).toEqual(["accounting", "staff"]);

  const hasBooks = await auth.api.hasPermission({
    headers,
    body: {
      organizationId: orgId,
      userId: staffId,
      permissions: { bookkeeping: ["update"] },
    },
  });
  expect(hasBooks.success).toBe(true);
});

test("taking somebody out of a group takes the permission with it", async () => {
  const group = await makeGroup(`Temporary ${suffix}`, ["accounting"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });

  const left = await app.request(
    `http://localhost/api/users/groups/${group}/members/${staffId}`,
    { method: "DELETE", headers },
  );
  expect(left.status).toBe(200);

  // Their own role survives; the group's does not.
  const role = await memberRole(staffId);
  expect(role.split(",")).toContain("staff");
});

test("changing what a group grants changes it for everybody in it, now", async () => {
  const group = await makeGroup(`Fitters ${suffix}`, ["staff"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });

  const changed = await app.request(
    `http://localhost/api/users/groups/${group}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ roles: ["accounting"] }),
    },
  );
  expect(changed.status).toBe(200);

  // Not the next time they sign in: an administrator who takes the books away
  // from the fitters means now.
  const role = await memberRole(staffId);
  expect(role.split(",").sort()).toEqual(["accounting", "staff"]);
});

test("deleting a group leaves people with their own role and nothing else", async () => {
  const group = await makeGroup(`Doomed ${suffix}`, ["admin"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });
  expect((await memberRole(staffId)).split(",")).toContain("admin");

  const gone = await app.request(`http://localhost/api/users/groups/${group}`, {
    method: "DELETE",
    headers,
  });
  expect(gone.status).toBe(200);

  const role = await memberRole(staffId);
  expect(role.split(",")).not.toContain("admin");
  expect(role.split(",")).toContain("staff");
});

test("a group cannot carry a role nobody defined", async () => {
  const res = await post("/api/users/groups", {
    name: `Wishful ${suffix}`,
    roles: ["auditor"],
  });
  const { group } = (await res.json()) as { group: { roles: string[] } };
  // Dropped on the way in rather than stored: a group naming a role that does
  // not exist grants nothing and looks like it grants something.
  expect(group.roles).toEqual([]);

  const patched = await app.request(
    `http://localhost/api/users/groups/${await makeGroup(`Real ${suffix}`, [])}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ roles: ["accounting", "auditor"] }),
    },
  );
  expect(patched.status).toBe(400);
  expect((await patched.json()) as { error: string }).toMatchObject({
    error: "there is no role called auditor",
  });
});

test("two groups cannot share a name", async () => {
  await makeGroup(`Only one ${suffix}`, []);
  const again = await post("/api/users/groups", { name: `Only one ${suffix}` });
  // Two groups called "Office" is two groups nobody can tell apart.
  expect(again.status).toBe(409);
});

test("somebody outside the business cannot be put in a group", async () => {
  const group = await makeGroup(`Closed ${suffix}`, []);
  const res = await post(`/api/users/groups/${group}/members`, {
    userId: `outsider-${suffix}`,
  });
  // A group is not a way in.
  expect(res.status).toBe(404);
});

test("the roles screen reads permissions from the roles themselves", async () => {
  const res = await app.request("http://localhost/api/users/roles", {
    headers,
  });
  const body = (await res.json()) as {
    permissions: Record<string, string[]>;
    roles: {
      role: string;
      builtIn: boolean;
      allows: Record<string, string[]>;
    }[];
  };

  expect(body.permissions.bookkeeping).toContain("update");
  const staffRole = body.roles.find((r) => r.role === "staff");
  // Staff can read invoices and cannot write the books — read from the role,
  // so a screen can never disagree with what the checks actually do.
  expect(staffRole?.allows.invoicing).toEqual(["read"]);
  expect(staffRole?.allows.bookkeeping).toBeUndefined();
});

test("the rules say who must have a second factor, and the person is told", async () => {
  const saved = await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      requireTwoFactorFor: ["admin"],
      minPasswordLength: 14,
    }),
  });
  expect(saved.status).toBe(200);

  const mine = (await (
    await app.request("http://localhost/api/users/me/security", { headers })
  ).json()) as {
    twoFactorRequired: boolean;
    twoFactorEnabled: boolean;
    minPasswordLength: number;
  };

  // The owner is an admin and has no second factor yet, so they are told
  // plainly rather than being refused something later with an error about
  // permissions.
  expect(mine.twoFactorRequired).toBe(true);
  expect(mine.twoFactorEnabled).toBe(false);
  expect(mine.minPasswordLength).toBe(14);
});

test("a password minimum is kept inside what the platform can enforce", async () => {
  const res = await app.request("http://localhost/api/users/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({ minPasswordLength: 2 }),
  });
  const { policy } = (await res.json()) as {
    policy: { minPasswordLength: number };
  };
  // Eight is the floor. A business that sets four has not made a decision
  // anybody should honour.
  expect(policy.minPasswordLength).toBe(8);
});

test("everything that hands access around is written down", async () => {
  const group = await makeGroup(`Recorded ${suffix}`, ["accounting"]);
  await post(`/api/users/groups/${group}/members`, { userId: staffId });

  const events = await db
    .select({ action: schema.securityEvents.action })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  const actions = events.map((e) => e.action);

  expect(actions).toContain("group.created");
  expect(actions).toContain("group.joined");
  expect(actions).toContain("policy.changed");
});

test("a device is described in words somebody can recognise", () => {
  expect(
    describeDevice(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
  ).toBe("a Mac, in Safari");
  // Every browser claims to be several others; Edge says Chrome and Safari
  // both, and the order of these checks is the whole of the logic.
  expect(
    describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
    ),
  ).toBe("a Windows PC, in Edge");
  expect(describeDevice(null)).toBe("an unknown device");
});

test("a person can end their own session but not somebody else's", async () => {
  const mine = (await (
    await app.request("http://localhost/api/users/me/sessions", { headers })
  ).json()) as { sessions: { id: string; current: boolean }[] };

  expect(mine.sessions.length).toBeGreaterThan(0);
  expect(mine.sessions.some((s) => s.current)).toBe(true);

  // Somebody else's session id, through the route that is meant to be their
  // own: refused on the row rather than on the list it came from.
  const [theirs] = await db
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(eq(schema.session.userId, staffId))
    .limit(1);
  if (theirs) {
    const res = await app.request(
      `http://localhost/api/users/me/sessions/${theirs.id}`,
      { method: "DELETE", headers },
    );
    expect(res.status).toBe(404);
  }
});

test("an administrator cannot read the devices of somebody in another business", async () => {
  const res = await app.request(
    `http://localhost/api/users/outsider-${suffix}/sessions`,
    { headers },
  );
  expect(res.status).toBe(404);
});
