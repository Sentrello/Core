import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewer, readStatus, rollbackTarget } from "./updates";

/**
 * Version comparison, which is the part of an update button that quietly gets
 * it wrong. A business told it is current while sitting a release behind has
 * no way to discover the mistake.
 */
test("a later patch is newer", () => {
  expect(isNewer("0.1.28", "0.1.27")).toBe(true);
  expect(isNewer("0.1.27", "0.1.28")).toBe(false);
});

test("ten is newer than nine, which string comparison gets backwards", () => {
  expect(isNewer("0.1.10", "0.1.9")).toBe(true);
  expect(isNewer("0.1.9", "0.1.10")).toBe(false);
  expect(isNewer("0.2.0", "0.1.99")).toBe(true);
});

test("the same version is not an update", () => {
  expect(isNewer("0.1.28", "0.1.28")).toBe(false);
});

test("a shorter version compares against the missing parts as zero", () => {
  expect(isNewer("1.0", "0.9.9")).toBe(true);
  expect(isNewer("1.0.1", "1.0")).toBe(true);
  expect(isNewer("1.0", "1.0.0")).toBe(false);
});

test("an unknown version claims nothing in either direction", () => {
  // Running from a checkout, where the image never stamped a version. Offering
  // an update from "unknown" is offering to do something nobody can predict.
  expect(isNewer("0.1.28", "unknown")).toBe(false);
  expect(isNewer("unknown", "0.1.28")).toBe(false);
});

test("a version that is not numbers claims nothing", () => {
  // A pre-release or a git sha. Better to show no update than to guess the
  // ordering of something that has none.
  expect(isNewer("0.2.0-rc1", "0.1.28")).toBe(false);
  expect(isNewer("main", "0.1.28")).toBe(false);
});

/**
 * A finished update clears itself.
 *
 * The agent cannot clear it — the container it would clear it for is the one it
 * just replaced — so the app compares what finished against what is running.
 */
test("a finished update stops being news once it is the running version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentrello-updates-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_VERSION = "0.2.1";

  await writeFile(
    join(dir, "update-status.json"),
    JSON.stringify({ state: "done", version: "0.2.1", message: "Updated." }),
  );
  expect((await readStatus()).state).toBe("idle");

  // But an update to a version that is not running did not take effect, and
  // saying nothing happened would hide exactly the failure worth seeing.
  await writeFile(
    join(dir, "update-status.json"),
    JSON.stringify({ state: "done", version: "0.2.2", message: "Updated." }),
  );
  expect((await readStatus()).state).toBe("done");
});

/**
 * Rollback, which the host records and the app only reports. The version is
 * never taken from a request body — a form must not be able to name the
 * release this instance runs.
 */
test("rollback is offered only when the host recorded somewhere to go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentrello-updates-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_VERSION = "0.2.1";

  // Nothing recorded: a fresh instance has never updated.
  expect(await rollbackTarget()).toBeNull();

  await writeFile(join(dir, "rollback-target"), "0.2.0\n");
  expect(await rollbackTarget()).toBe("0.2.0");
});

test("it never offers to go back to what is already running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentrello-updates-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_VERSION = "0.2.1";

  // Left over from a rollback that already happened. Offering it would restart
  // the business to arrive exactly where it started.
  await writeFile(join(dir, "rollback-target"), "0.2.1\n");
  expect(await rollbackTarget()).toBeNull();
});
