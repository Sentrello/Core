import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AD_HEIGHT,
  AD_WIDTH,
  BUILT_IN,
  promosEnabled,
  readPromos,
  refreshPromos,
  safeUrl,
  validatePromos,
} from "./promos";

/**
 * The advertisement arrives over the network, which makes it input. These
 * tests are about what a document is not allowed to do to the page it lands
 * on, and about the block never being the reason a dashboard is empty.
 */

const good = {
  ad: {
    kind: "text",
    headline: "Get paid faster with Sentrello Pro",
    body: "Automatic chasing and the reports your accountant asks for.",
    cta: "See Pro",
    url: "https://sentrello.com/pro",
  },
};

const banner = {
  ad: {
    kind: "image",
    imageUrl: "https://ads.test/banner.png",
    alt: "A banner",
    url: "https://ads.test",
  },
};

const env = { ...process.env };
afterEach(() => {
  process.env.SENTRELLO_PROMOS = env.SENTRELLO_PROMOS;
  process.env.SENTRELLO_DATA_DIR = env.SENTRELLO_DATA_DIR;
});

test("a link is https or it is not a link", () => {
  expect(safeUrl("https://sentrello.com")).toBe("https://sentrello.com/");
  // The obvious one, and the one that matters more: a page that is otherwise
  // entirely local must not send somebody off over cleartext.
  expect(safeUrl("javascript:alert(1)")).toBeNull();
  expect(safeUrl("http://sentrello.com")).toBeNull();
  expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  expect(safeUrl("  not a url ")).toBeNull();
});

test("a document without a headline or a link is not used", () => {
  expect(
    validatePromos({ ad: { kind: "text", headline: "", url: "" } }),
  ).toBeNull();
  expect(validatePromos({ ad: { kind: "text", headline: "Hi" } })).toBeNull();
  expect(
    validatePromos({ ad: { kind: "text", url: "https://x.test" } }),
  ).toBeNull();
  expect(validatePromos({})).toBeNull();
  expect(validatePromos("a string")).toBeNull();
  expect(validatePromos(null)).toBeNull();
});

test("an advertisement with an unusable link is refused entirely", () => {
  // There is only one block now, so there is nothing to fall back to within
  // the document — a bad link means the whole thing is ignored and the
  // built-in copy shows instead.
  expect(
    validatePromos({
      ad: { kind: "text", headline: "Someone", url: "javascript:alert(1)" },
    }),
  ).toBeNull();
});

test("a banner needs an image over TLS", () => {
  expect(
    validatePromos({
      ad: {
        kind: "image",
        imageUrl: "http://ads.test/banner.png",
        url: "https://ads.test",
      },
    }),
  ).toBeNull();

  expect(validatePromos(banner)?.ad).toEqual({
    kind: "image",
    imageUrl: "https://ads.test/banner.png",
    alt: "A banner",
    url: "https://ads.test/",
  });
});

test("long copy is cut rather than allowed to break the slot", () => {
  // The slot is a fixed 728x90. Copy that does not fit is cropped by the box
  // anyway; cutting it here keeps the cached document small too.
  const parsed = validatePromos({
    ad: {
      kind: "text",
      headline: "H".repeat(500),
      body: "B".repeat(500),
      url: "https://sentrello.com",
    },
  });
  const ad = parsed?.ad;
  if (ad?.kind !== "text") throw new Error("expected a text advertisement");
  expect(ad.headline.length).toBe(80);
  expect(ad.body.length).toBe(140);
});

test("a failed fetch keeps yesterday's copy rather than clearing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  const stored = await refreshPromos(
    async () => new Response(JSON.stringify(good), { status: 200 }),
  );
  expect(stored?.ad.kind).toBe("text");

  // Server down, then serving rubbish. Neither may blank the block.
  expect(
    await refreshPromos(async () => {
      throw new Error("connection refused");
    }),
  ).toBeNull();
  expect(
    await refreshPromos(
      async () => new Response("not json at all", { status: 200 }),
    ),
  ).toBeNull();
  expect(
    await refreshPromos(async () => new Response("{}", { status: 500 })),
  ).toBeNull();

  const kept = await readPromos();
  if (kept.ad.kind !== "text") throw new Error("expected a text advertisement");
  expect(kept.ad.headline).toBe("Get paid faster with Sentrello Pro");
  expect(
    JSON.parse(await readFile(join(dir, "promos.json"), "utf8")).ad.headline,
  ).toBe("Get paid faster with Sentrello Pro");
});

test("a document that does not validate falls back to the built-in copy", async () => {
  // The case that matters most: something well-formed enough to parse but not
  // to trust. It must not reach the screen and must not blank it either.
  const dir = await mkdtemp(join(tmpdir(), "promos-bad-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  expect(
    await refreshPromos(
      async () =>
        new Response(JSON.stringify({ ad: { kind: "text", headline: "Hi" } }), {
          status: 200,
        }),
    ),
  ).toBeNull();
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("with nothing cached, the built-in copy is what shows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-empty-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("turned off means no fetch and no cached copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "promos-off-"));
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";
  await refreshPromos(
    async () => new Response(JSON.stringify(good), { status: 200 }),
  );

  process.env.SENTRELLO_PROMOS = "off";
  expect(promosEnabled()).toBe(false);
  let called = 0;
  expect(
    await refreshPromos(async () => {
      called += 1;
      return new Response(JSON.stringify(good), { status: 200 });
    }),
  ).toBeNull();
  expect(called).toBe(0);
  // And the block goes back to what shipped, rather than the last thing we sent.
  expect(await readPromos()).toEqual(BUILT_IN);
});

test("the slot is one fixed leaderboard", () => {
  // Both ends have to agree on the size, or a banner uploaded in Master is the
  // wrong shape for the hole it goes in.
  expect(AD_WIDTH).toBe(728);
  expect(AD_HEIGHT).toBe(90);
});
