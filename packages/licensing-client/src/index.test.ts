import { expect, test } from "bun:test";
import { SignJWT, importPKCS8, importSPKI } from "jose";
import {
  SENTRELLO_LICENSE_PUBLIC_KEY,
  makeEntitlementGate,
  verifyLicenseToken,
} from "./index";

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

test("the embedded production key is a usable Ed25519 public key", async () => {
  const key = await importSPKI(SENTRELLO_LICENSE_PUBLIC_KEY, ALG);
  expect(key).toBeDefined();
  expect(SENTRELLO_LICENSE_PUBLIC_KEY).toContain("-----BEGIN PUBLIC KEY-----");
  // a public key only: shipping a private key in the open core would be fatal
  expect(SENTRELLO_LICENSE_PUBLIC_KEY).not.toContain("PRIVATE KEY");
});

test("verification defaults to the embedded key, so a stock instance needs no config", async () => {
  // A token from the dev keypair must NOT validate against the production key.
  const token = await mint({ tier: "pro", modules: [] });
  const state = await verifyLicenseToken(token);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});

test("a token signed by any trusted key verifies, which is what makes rotation possible", async () => {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const rotated = await generateKeyPair(ALG, { extractable: true });
  const newPub = await exportSPKI(rotated.publicKey);
  const newPriv = await exportPKCS8(rotated.privateKey);

  const signedWithNew = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(await importPKCS8(newPriv, ALG));

  // during rotation an instance trusts both keys
  const during = await verifyLicenseToken(signedWithNew, [pub, newPub]);
  expect(during.valid).toBe(true);

  // a token from the old key still works while the old key is trusted
  const signedWithOld = await mint({ tier: "pro", modules: [] });
  expect((await verifyLicenseToken(signedWithOld, [pub, newPub])).valid).toBe(
    true,
  );

  // once the old key is dropped, its tokens stop verifying
  expect((await verifyLicenseToken(signedWithOld, [newPub])).valid).toBe(false);
});

test("an untrusted key is rejected however many keys are trusted", async () => {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import("jose");
  const stranger = await generateKeyPair(ALG, { extractable: true });
  const forged = await new SignJWT({ tier: "pro", modules: [] })
    .setProtectedHeader({ alg: ALG })
    .setIssuer("sentrello.com")
    .setIssuedAt()
    .setExpirationTime("72h")
    .sign(await importPKCS8(await exportPKCS8(stranger.privateKey), ALG));

  const state = await verifyLicenseToken(forged, [
    pub,
    await exportSPKI(
      (await generateKeyPair(ALG, { extractable: true })).publicKey,
    ),
  ]);
  expect(state.valid).toBe(false);
  expect(makeEntitlementGate(state)({ tier: "pro" })).toBe(false);
});
