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
  // Optional modules declare their resources here too: the access-control
  // statement is compiled into the client as well as the server, so it cannot
  // be extended at runtime by a bundle.
  time: ["read", "create", "update", "delete", "approve"],
  scheduling: ["read", "create", "update", "delete"],
  shop: ["read", "create", "update", "delete"],
  projects: ["read", "create", "update", "delete"],
  inventory: ["read", "create", "update", "delete"],
  documents: ["read", "create", "update", "delete"],
  hr: ["read", "create", "update", "delete", "approve"],
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
  time: ["read", "create", "update", "delete", "approve"],
  scheduling: ["read", "create", "update", "delete"],
  shop: ["read", "create", "update", "delete"],
  projects: ["read", "create", "update", "delete"],
  inventory: ["read", "create", "update", "delete"],
  documents: ["read", "create", "update", "delete"],
  hr: ["read", "create", "update", "delete", "approve"],
});

export const accounting = ac.newRole({
  crm: ["read"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  reports: ["read"],
  settings: ["read"],
  // approving time is what turns it into something invoiceable, so it belongs
  // with the people who invoice
  time: ["read", "approve"],
  scheduling: ["read"],
  // whoever does the books needs to see what was sold and refunded
  shop: ["read"],
  // a job's profitability is a bookkeeping question before it is anyone else's
  projects: ["read", "create", "update"],
  // closing stock is a number the books depend on
  inventory: ["read"],
  // an accountant asks for the insurance certificate as often as anyone
  documents: ["read"],
  // payroll needs to see who was off; approving leave is the owner's job
  hr: ["read"],
});

export const staff = ac.newRole({
  crm: ["read", "create", "update"],
  invoicing: ["read"],
  reports: [],
  settings: [],
  // everyone tracks their own time; approving it is someone else's job
  time: ["read", "create", "update"],
  // staff manage the diary; only an admin reshapes the business hours
  scheduling: ["read", "create", "update"],
  // staff can see orders; prices and products are the owner's business
  shop: ["read"],
  // staff work on jobs and record against them; deleting one is not theirs
  projects: ["read", "create", "update"],
  // staff move stock all day; what it costs and what it sells for is not theirs
  inventory: ["read", "create", "update"],
  // staff need to produce a certificate on site; removing one is not theirs
  documents: ["read", "create", "update"],
  // everyone books their own time off; approving it is deliberately not here,
  // because in a business of five people that separation is the only control
  hr: ["read", "create"],
});

// External portal users — RBAC is intentionally tiny; row-level scoping to their
// OWN records is enforced in the module routes, not by RBAC alone.
export const customer = ac.newRole({
  invoicing: ["read"],
});

export const roles = { admin, accounting, staff, customer };
