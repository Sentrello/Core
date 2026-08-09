import type { EntitlementNeed } from "@sentrello/module-sdk";
import { type JWTPayload, importSPKI, jwtVerify } from "jose";

const ALG = "EdDSA"; // Ed25519

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

/** Verify a token offline using the SPKI public-key PEM shipped in the core. */
export async function verifyLicenseToken(
  token: string,
  publicKeyPem: string,
): Promise<LicenseState> {
  try {
    const pub = await importSPKI(publicKeyPem, ALG);
    const { payload } = await jwtVerify(token, pub, {
      issuer: "sentrello.com",
    });
    return { claims: payload as LicenseClaims, valid: true };
  } catch (err) {
    // expired / tampered / wrong key => fall back to Free, never crash the app
    return { claims: null, valid: false, reason: (err as Error).message };
  }
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
