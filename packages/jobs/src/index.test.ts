import { afterAll, expect, test } from "bun:test";
import type PgBoss from "pg-boss";
import { QUEUES, SCHEDULES, startJobs } from "./index";
import { refreshLicenseToken } from "./license-refresh";

let boss: PgBoss | undefined;

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

test("startJobs registers a cron schedule for all three queues", async () => {
  boss = await startJobs();
  const schedules = await boss.getSchedules();
  const byName = new Map(schedules.map((s) => [s.name, s.cron]));

  for (const queue of Object.values(QUEUES)) {
    expect(byName.get(queue)).toBe(SCHEDULES[queue]);
  }
});

test("license-refresh no-ops cleanly on a Free instance", async () => {
  // no license key: a Free instance has nothing to refresh and must not call out
  expect(
    await refreshLicenseToken({
      serverUrl: "https://sentrello.com",
      tokenPath: "secrets/license_token.jwt",
    }),
  ).toEqual({ refreshed: false });
});

test("license-refresh survives an unreachable license server", async () => {
  expect(
    await refreshLicenseToken({
      // closed local port: refused immediately, no request leaves the machine
      serverUrl: "http://127.0.0.1:1",
      licenseKey: "lic_test",
      instanceId: "inst_test",
      tokenPath: "secrets/should-never-be-written.jwt",
    }),
  ).toEqual({ refreshed: false });

  expect(await Bun.file("secrets/should-never-be-written.jwt").exists()).toBe(
    false,
  );
});

test("license-refresh keeps the old token when the server rejects the key", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("revoked", { status: 403 }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_revoked",
        instanceId: "inst_test",
        tokenPath: "secrets/should-never-be-written.jwt",
      }),
    ).toEqual({ refreshed: false });
    expect(await Bun.file("secrets/should-never-be-written.jwt").exists()).toBe(
      false,
    );
  } finally {
    server.stop(true);
  }
});

test("license-refresh writes a fresh token when the server issues one", async () => {
  const tokenPath = "secrets/test-refreshed-token.jwt";
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ token: "fresh.token.value" }),
  });
  try {
    expect(
      await refreshLicenseToken({
        serverUrl: `http://127.0.0.1:${server.port}`,
        licenseKey: "lic_active",
        instanceId: "inst_test",
        tokenPath,
      }),
    ).toEqual({ refreshed: true });
    expect(await Bun.file(tokenPath).text()).toBe("fresh.token.value");
  } finally {
    server.stop(true);
    await Bun.file(tokenPath)
      .delete()
      .catch(() => {});
  }
});
