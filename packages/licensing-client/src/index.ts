import type { EntitlementNeed } from "@sentrello/module-sdk";
import { type JWTPayload, importSPKI, jwtVerify } from "jose";
import {
  SENTRELLO_LICENSE_PUBLIC_KEY,
  SENTRELLO_LICENSE_PUBLIC_KEYS,
} from "./public-key";

const ALG = "EdDSA"; // Ed25519

export {
  SENTRELLO_LICENSE_PUBLIC_KEY,
  SENTRELLO_LICENSE_PUBLIC_KEYS,
} from "./public-key";

export interface LicenseClaims extends JWTPayload {
  license_id: string;
  instance_id: string;
  tier: "free" | "pro";
  modules: string[];
  seats: number;
  grace_until: string | null;
}

export interface LicenseState {
  claims: LicenseClaims | null; // null => treat as Free
  valid: boolean;
  reason?: string;
}

/**
 * Verify a token offline using the SPKI public-key PEM shipped in the core.
 * The key defaults to the embedded one, so a stock instance needs no config.
 */
export async function verifyLicenseToken(
  token: string,
  publicKeyPem: string | string[] = SENTRELLO_LICENSE_PUBLIC_KEYS,
): Promise<LicenseState> {
  const keys = Array.isArray(publicKeyPem) ? publicKeyPem : [publicKeyPem];
  let reason = "no trusted key accepted the token";

  for (const pem of keys) {
    try {
      const pub = await importSPKI(pem, ALG);
      const { payload } = await jwtVerify(token, pub, {
        issuer: "sentrello.com",
      });
      return { claims: payload as LicenseClaims, valid: true };
    } catch (err) {
      // try the next trusted key: during a rotation both are valid for a while
      reason = (err as Error).message;
    }
  }

  // expired / tampered / signed by a key we do not trust => fall back to Free,
  // never crash the app
  return { claims: null, valid: false, reason };
}

/** The gate every module and route uses. Free is the safe default. */
export function makeEntitlementGate(state: LicenseState) {
  const claims = state.valid ? state.claims : null;
  const tier = claims?.tier ?? "free";
  const modules = claims?.modules ?? [];
  return (need: EntitlementNeed): boolean => {
    if (need.tier === "pro" && tier !== "pro") return false;
    if (need.module && !modules.includes(need.module)) return false;
    return true;
  };
}
