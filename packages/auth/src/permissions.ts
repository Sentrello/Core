import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

// Resources Sentrello guards, on top of Better Auth's org/member/invitation defaults.
export const statement = {
  ...defaultStatements,
  // The first screen after signing in. Read-only and held by every role,
  // including the ones that can do almost nothing else — a person who cannot
  // see the landing page has nowhere to land.
  dashboard: ["read"],
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
  // Sentrello's own storefront, which only ever runs on bmp. It is a separate
  // resource from `shop` because the two can run side by side there, and
  // selling our own subscriptions is not the same job as selling a customer's
  // products.
  documents: ["read", "create", "update", "delete"],
  /**
   * The mailing list.
   *
   * `send` is its own action for the same reason invoicing's is: writing a
   * campaign and putting it in front of eleven thousand people are different
   * decisions, and a business with a marketing assistant wants the first
   * without the second.
   */
  newsletter: ["read", "create", "update", "delete", "send"],
  /**
   * The documentation site.
   *
   * `read` opens the screens; `update` connects the repository and changes how
   * the site looks; `delete` removes a version or a language, which takes that
   * version's pages with it.
   *
   * The published site itself is public and guarded by none of this — a reader
   * has no account. These are for the business's own screens.
   */
  docs: ["read", "create", "update", "delete"],
  /**
   * Withdrawn modules, kept as resources and granted by nothing.
   *
   * Inventory, Make Deal, HR, Time Tracking and Projects are gone for good —
   * no code, no bundle, nothing on the price list. Projects was built and
   * deleted the day after. These names stay in the statement and nowhere else.
   *
   * The reason is that a business can define its own roles, and one saved
   * before the modules were withdrawn may still name them. A statement that no
   * longer knows a resource is a role that fails to load, which locks somebody
   * out of the modules that *are* installed — a worse outcome than a handful
   * of dead keys. They appear in no built-in role, so they grant nothing.
   *
   * Delete them when the role loader ignores resources it does not recognise
   * rather than refusing the whole statement.
   */
  inventory: ["read", "create", "update", "delete"],
  hr: ["read", "create", "update", "delete", "approve"],
  "make-deal": ["read", "create", "update"],
  projects: ["read", "create", "update", "delete"],
} as const;

export const ac = createAccessControl(statement);

// Instance Owner — full control of THEIR business (not a platform super admin;
// that's Packet 03).
export const admin = ac.newRole({
  ...adminAc.statements,
  dashboard: ["read"],
  crm: ["read", "create", "update", "delete"],
  invoicing: ["read", "create", "update", "delete", "send"],
  bookkeeping: ["read", "create", "update", "delete"],
  reports: ["read"],
  settings: ["read", "update"],
  time: ["read", "create", "update", "delete", "approve"],
  scheduling: ["read", "create", "update", "delete"],
  shop: ["read", "create", "update", "delete"],
  documents: ["read", "create", "update", "delete"],
  newsletter: ["read", "create", "update", "delete", "send"],
  docs: ["read", "create", "update", "delete"],
});

// External portal users — RBAC is intentionally tiny; row-level scoping to their
// OWN records is enforced in the module routes, not by RBAC alone.
export const customer = ac.newRole({
  dashboard: ["read"],
  invoicing: ["read"],
});

/**
 * The roles compiled into the product.
 *
 * Deliberately two, not four. Better Auth reserves exactly these names —
 * `Object.keys(roles)` — and refuses to let a business define a role of its
 * own by any of them. Every name here is a name the owner of the instance can
 * never use, so the list is kept to the ones that genuinely cannot be data:
 *
 * `admin` is what the instance owner is given when the instance is claimed,
 * before any organization exists to hold a row. A business able to delete it
 * could lock itself out of its own machine.
 *
 * `customer` is assigned by the portal when somebody is granted access, which
 * is code rather than a person choosing from a list.
 *
 * `staff` and `accounting` used to be here, and being here was the only reason
 * a business could not edit them. They are ordinary roles now, created from
 * the same defaults as Executives, Managers and the rest, and they can be
 * renamed, changed and deleted like any other. Their permissions live in the
 * users module's defaults, which is the one place that describes them.
 */
export const roles = { admin, customer };
