import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

// Resources Sentrello guards, on top of Better Auth's org/member/invitation defaults.
export const statement = {
  ...defaultStatements,
  crm: ["read", "create", "update", "delete"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  reports: ["read"],
  settings: ["read", "update"],
} as const;

export const ac = createAccessControl(statement);

// Instance Owner — full control of THEIR business (not a platform super admin;
// that's Packet 03).
export const admin = ac.newRole({
  ...adminAc.statements,
  crm: ["read", "create", "update", "delete"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  reports: ["read"],
  settings: ["read", "update"],
});

export const accounting = ac.newRole({
  crm: ["read"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  reports: ["read"],
  settings: ["read"],
});

export const staff = ac.newRole({
  crm: ["read", "create", "update"],
  invoicing: ["read"],
  reports: [],
  settings: [],
});

// External portal users — RBAC is intentionally tiny; row-level scoping to their
// OWN records is enforced in the module routes, not by RBAC alone.
export const customer = ac.newRole({
  invoicing: ["read"],
});

export const roles = { admin, accounting, staff, customer };
