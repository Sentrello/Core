import { expect, test } from "bun:test";
import { SignJWT, importPKCS8 } from "jose";
import { makeEntitlementGate, verifyLicenseToken } from "./index";

const ALG = "EdDSA";
const priv = await Bun.file("secrets/license_private.pem").text();
const pub = await Bun.file("secrets/license_public.pem").text();

async function mint(claims: Record<string, unknown>, exp = "72h") {
  const key = await importPKCS8(priv, ALG);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key);
}

test("valid pro token verifies + gates correctly", async () => {
  const token = await mint({ tier: "pro", modules: ["hr"], seats: 20 });
  const state = await verifyLicenseToken(token, pub);
  expect(state.valid).toBe(true);
  const gate = makeEntitlementGate(state);
  expect(gate({ tier: "pro" })).toBe(true);
  expect(gate({ module: "hr" })).toBe(true);
  expect(gate({ module: "inventory" })).toBe(false);
});

test("expired token downgrades to Free, does not throw", async () => {
  const token = await mint({ tier: "pro", modules: [] }, "-1s");
  const state = await verifyLicenseToken(token, pub);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});

test("tampered token rejected", async () => {
  const token = `${(await mint({ tier: "pro", modules: [] })).slice(0, -3)}AAA`;
  expect((await verifyLicenseToken(token, pub)).valid).toBe(false);
});

test("wrong issuer rejected", async () => {
  const key = await importPKCS8(priv, ALG);
  const token = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("evil.example")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(key);
  expect((await verifyLicenseToken(token, pub)).valid).toBe(false);
});

test("missing/garbage token downgrades to Free, does not throw", async () => {
  const state = await verifyLicenseToken("not-a-jwt", pub);
  expect(state.valid).toBe(false);
  expect(state.claims).toBeNull();
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
  // Free needs are still satisfied with no license at all.
  expect(makeEntitlementGate(state)({})).toBe(true);
});
