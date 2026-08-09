import {
  type LicenseState,
  makeEntitlementGate,
  verifyLicenseToken,
} from "@sentrello/licensing-client";

export async function resolveLicense() {
  const pubPath = process.env.SENTRELLO_LICENSE_PUBLIC_KEY_PATH;
  if (!pubPath) throw new Error("SENTRELLO_LICENSE_PUBLIC_KEY_PATH is not set");
  const tokenPath = process.env.SENTRELLO_LICENSE_TOKEN_PATH;

  const publicKeyPem = await Bun.file(pubPath).text();
  let token = "";
  if (tokenPath) {
    const f = Bun.file(tokenPath);
    if (await f.exists()) token = (await f.text()).trim();
  }

  const state: LicenseState = token
    ? await verifyLicenseToken(token, publicKeyPem)
    : { claims: null, valid: false, reason: "no token (Free)" };

  return { state, gate: makeEntitlementGate(state) };
}
// Packet 03 adds: a pg-boss daily job that fetches a fresh token from
// SENTRELLO_LICENSE_SERVER_URL and writes it to tokenPath (the online check).
