import { licenseKey as storedLicenseKey } from "@sentrello/licensing-client";

export interface LicenseRefreshConfig {
  serverUrl?: string | undefined;
  licenseKey?: string | undefined;
  instanceId?: string | undefined;
  tokenPath?: string | undefined;
}

/**
 * The key comes from `licenseKey()` rather than straight from the environment,
 * so a key entered in Settings by someone upgrading from Free is picked up by
 * the daily refresh exactly like one the installer wrote.
 */
async function configFromEnv(): Promise<LicenseRefreshConfig> {
  return {
    serverUrl: process.env.SENTRELLO_LICENSE_SERVER_URL,
    licenseKey: (await storedLicenseKey()) ?? undefined,
    instanceId: process.env.SENTRELLO_INSTANCE_ID,
    tokenPath: process.env.SENTRELLO_LICENSE_TOKEN_PATH,
  };
}

/**
 * The daily online check from Build Plan §4.2/§4.3. Fetches a fresh short-lived
 * token; if the server is unreachable or the subscription lapsed, the instance
 * keeps its last token until expiry and then downgrades to Free. The
 * `/api/license/token` endpoint itself is built in Packet 03.
 */
export async function refreshLicenseToken(config?: LicenseRefreshConfig) {
  const { serverUrl, licenseKey, instanceId, tokenPath } =
    config ?? (await configFromEnv());
  // Free instance: nothing to refresh
  if (!serverUrl || !licenseKey || !tokenPath) return { refreshed: false };

  try {
    const res = await fetch(`${serverUrl}/api/license/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        license_key: licenseKey,
        instance_id: instanceId,
      }),
      // a hung license server must not hang the daily job forever
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Keep the existing token until it expires — but carry back why, because
      // "refused" and "unreachable" need completely different actions from the
      // person standing at the terminal, and they used to be indistinguishable.
      const { error } = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      return { refreshed: false, error };
    }
    const { token } = (await res.json()) as { token?: string };
    if (!token) return { refreshed: false };
    await Bun.write(tokenPath, token);
    return { refreshed: true };
  } catch {
    // offline: keep last token; graceful-lockdown in licensing-client handles expiry
    return { refreshed: false };
  }
}
