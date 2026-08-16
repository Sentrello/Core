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
    // dynamicAccessControl here as well as on the server: without it the
    // client has no createRole/listRoles at all, and the roles screen has
    // nothing to call.
    //
    // The cast is not laziness — removing it fails, because our concrete
    // AccessControl is not assignable to the plugin's open `Statements` shape.
    // It is also what erases the dynamic methods from the client's type, which
    // is why they are named explicitly below.
    organizationClient({
      ac,
      roles,
      dynamicAccessControl: { enabled: true },
    } as Parameters<typeof organizationClient>[0]),
  ],
});

export const { useSession, signIn, signOut, signUp } = authClient;

/**
 * The dynamic-role endpoints.
 *
 * They exist on the client at runtime — `dynamicAccessControl` adds them — but
 * the cast above erases the generic that would reveal them to TypeScript, so
 * the plugin resolves to its base shape. Named here once, deliberately, rather
 * than casting at each of the four call sites where the reason would be lost.
 */
export interface OrgRole {
  id: string;
  role: string;
  permission: string;
}

interface RoleApi {
  listRoles: () => Promise<{ data?: OrgRole[]; error?: { message?: string } }>;
  createRole: (input: {
    role: string;
    permission: Record<string, string[]>;
  }) => Promise<{ error?: { message?: string } }>;
  deleteRole: (input: {
    roleName: string;
  }) => Promise<{ error?: { message?: string } }>;
}

export const roleApi = authClient.organization as unknown as RoleApi;

export interface Member {
  id: string;
  role: string;
  userId: string;
  user: { id: string; name?: string | null; email: string };
}

interface MemberApi {
  listMembers: () => Promise<{
    data?: { members: Member[] };
    error?: { message?: string };
  }>;
  updateMemberRole: (input: {
    memberId: string;
    role: string;
  }) => Promise<{ error?: { message?: string } }>;
}

export const memberApi = authClient.organization as unknown as MemberApi;
