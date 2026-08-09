import { afterAll, expect, test } from "bun:test";
import { SignJWT, importPKCS8 } from "jose";
import { resolveLicense } from "./license";

const ALG = "EdDSA";
const TOKEN_PATH = "secrets/test_license_token.jwt";

async function writeToken(
  claims: Record<string, unknown>,
  exp: string,
): Promise<void> {
  const key = await importPKCS8(
    await Bun.file("secrets/license_private.pem").text(),
    ALG,
  );
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
  await Bun.write(TOKEN_PATH, token);
}

afterAll(async () => {
  await Bun.file(TOKEN_PATH)
    .delete()
    .catch(() => {});
});

test("a valid Pro token yields tier=pro and its module entitlements", async () => {
  await writeToken(
    { tier: "pro", modules: ["hr"], seats: 20, license_id: "dev" },
    "72h",
  );
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = TOKEN_PATH;

  const { state, gate } = await resolveLicense();
  expect(state.valid).toBe(true);
  expect(state.claims?.tier).toBe("pro");
  expect(gate({ tier: "pro" })).toBe(true);
  expect(gate({ module: "hr" })).toBe(true);
  expect(gate({ module: "inventory" })).toBe(false);
});

test("an expired token downgrades to Free without throwing", async () => {
  await writeToken({ tier: "pro", modules: ["hr"] }, "-1s");
  process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH = "secrets/license_public.pem";
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = TOKEN_PATH;

  const { state, gate } = await resolveLicense();
  expect(state.valid).toBe(false);
  expect(gate({ tier: "pro" })).toBe(false);
  expect(gate({ module: "hr" })).toBe(false);
});
