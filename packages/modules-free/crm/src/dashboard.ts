/**
 * The CRM's own dashboard: four questions, answered on opening it.
 *
 * Modelled on Atomic CRM's, which is a good dashboard because it is short —
 * who is going cold, what is about to land, what happened lately, what is due.
 * Its "Welcome" stepper is deliberately absent: a panel explaining the product
 * to somebody who already bought it is a panel they scroll past forever.
 *
 * Deliberately separate from the platform dashboard. That one answers "how is
 * the business doing" across every module; this one answers "what is happening
 * with my customers", and merging them produces a screen that does neither.
 */
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, isNull, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";

/** Long enough that a quiet fortnight is not an alarm, short enough to act on. */
const GOING_COLD_DAYS = 30;

/** What "upcoming" means for revenue and for tasks. */
const HORIZON_DAYS = 30;

const daysFromNow = (days: number): Date =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

export function registerCrmDashboard(ctx: ModuleContext) {
  ctx.app.get(
    "/api/crm/dashboard",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const now = new Date();

      const [recentActivity, openDeals, dueTasks, contacts] = await Promise.all(
        [
          db
            .select()
            .from(schema.activities)
            .where(eq(schema.activities.organizationId, orgId))
            .orderBy(desc(schema.activities.occurredAt))
            .limit(200),
          db
            .select()
            .from(schema.deals)
            .where(
              and(
                eq(schema.deals.organizationId, orgId),
                isNull(schema.deals.archivedAt),
              ),
            ),
          db
            .select()
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.organizationId, orgId),
                eq(schema.tasks.done, false),
              ),
            ),
          db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.organizationId, orgId)),
        ],
      );

      /**
       * Hot contacts: the ones with something happening, most recent first.
       *
       * Atomic CRM ranks by last-seen activity, which is the right instinct —
       * a CRM's job is to surface the relationship that is live, not the
       * alphabetically first. Contacts with no activity at all are excluded
       * rather than ranked last: a list that opens with people nobody has ever
       * spoken to teaches you to ignore the list.
       */
      const lastSeen = new Map<string, Date>();
      for (const activity of recentActivity) {
        if (!activity.contactId) continue;
        const at = activity.occurredAt;
        const known = lastSeen.get(activity.contactId);
        if (!known || at > known) lastSeen.set(activity.contactId, at);
      }

      const byId = new Map(contacts.map((contact) => [contact.id, contact]));
      const hot = [...lastSeen.entries()]
        .sort((a, b) => b[1].getTime() - a[1].getTime())
        .slice(0, 8)
        .map(([contactId, at]) => {
          const contact = byId.get(contactId);
          return contact
            ? {
                id: contact.id,
                name: contact.name,
                email: contact.email,
                companyId: contact.companyId,
                lastActivityAt: at,
              }
            : null;
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      /**
       * Upcoming revenue: what is expected to close inside the horizon.
       *
       * Not weighted by stage. A probability-weighted forecast is a number
       * nobody can check and everybody argues with; "these four deals say they
       * close this month, and they add up to this" is a number somebody can
       * act on this afternoon.
       */
      const horizon = daysFromNow(HORIZON_DAYS);
      const closingSoon = openDeals
        .filter((deal) => {
          if (!deal.expectedCloseOn) return false;
          const due = new Date(deal.expectedCloseOn);
          return due >= now && due <= horizon;
        })
        .sort(
          (a, b) =>
            new Date(a.expectedCloseOn as string).getTime() -
            new Date(b.expectedCloseOn as string).getTime(),
        );

      /**
       * Overdue is its own number rather than part of the total.
       *
       * A deal whose close date has passed is not upcoming revenue — it is a
       * conversation somebody has been avoiding, and adding it to the forecast
       * hides exactly the thing worth seeing.
       */
      const overdue = openDeals.filter(
        (deal) => deal.expectedCloseOn && new Date(deal.expectedCloseOn) < now,
      );

      const sum = (rows: typeof openDeals) =>
        rows.reduce((total, deal) => total + deal.amountCents, 0);

      const tasksDue = dueTasks
        .filter((task) => task.dueAt)
        .sort(
          (a, b) => (a.dueAt as Date).getTime() - (b.dueAt as Date).getTime(),
        )
        .slice(0, 8)
        .map((task) => ({
          id: task.id,
          title: task.title,
          type: task.type,
          dueAt: task.dueAt,
          contactId: task.contactId,
          dealId: task.dealId,
          overdue: (task.dueAt as Date) < now,
        }));

      return c.json({
        hotContacts: hot,
        upcomingRevenue: {
          horizonDays: HORIZON_DAYS,
          totalCents: sum(closingSoon),
          deals: closingSoon.slice(0, 8).map((deal) => ({
            id: deal.id,
            name: deal.name,
            amountCents: deal.amountCents,
            stage: deal.stage,
            expectedCloseOn: deal.expectedCloseOn,
            companyId: deal.companyId,
          })),
          overdue: {
            count: overdue.length,
            totalCents: sum(overdue),
          },
        },
        latestActivity: recentActivity.slice(0, 10).map((activity) => ({
          id: activity.id,
          type: activity.type,
          body: activity.body,
          occurredAt: activity.occurredAt,
          contactId: activity.contactId,
          dealId: activity.dealId,
        })),
        tasks: tasksDue,
        /**
         * The quiet ones, counted rather than listed.
         *
         * A number invites a click; eight names invite scrolling past. The
         * contacts screen already filters, so this is a prompt to go there.
         */
        goingCold: contacts.filter((contact) => {
          const at = lastSeen.get(contact.id);
          return at ? at < daysFromNow(-GOING_COLD_DAYS) : false;
        }).length,
      });
    },
  );
}
