import { ac, roles } from "@sentrello/auth/permissions";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// The client mirrors the server's access control, so the UI can hide what the
// user cannot do. The server still enforces it — this is presentation only.
export const authClient = createAuthClient({
  // the cast is variance-only: `ac` is a concrete AccessControl built from our
  // statement, while the plugin's parameter is typed against the open
  // `Statements` shape
  plugins: [
    organizationClient({ ac, roles } as Parameters<
      typeof organizationClient
    >[0]),
  ],
});

export const { useSession, signIn, signOut, signUp } = authClient;
