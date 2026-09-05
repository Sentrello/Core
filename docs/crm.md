# CRM — design

Rebuilt into our stack from the tool a small business would otherwise use to
keep track of its customers. Reverse engineered rather than ported: its data model, its screens and its
vocabulary studied first, then rebuilt on this stack.

## Feature for feature

| The reference | Here |
|---|---|
| Organise contacts | Contacts, with tags, statuses, several emails and phone numbers, and an owner |
| Create tasks and set reminders | Tasks against a contact, a company or a deal, with types a business names itself. Tick off, postpone a day or a week, edit or delete from the row, on the CRM dashboard and on the contact and company screens alike |
| Take notes | Notes on contacts and deals, with file attachments |
| Capture emails — CC the CRM to save communications as notes | `POST /api/crm/inbound-email/:orgId/:secret`, set up on the CRM settings screen |
| Manage deals in a Kanban board | The deals board, with drag-and-drop, keyboard moves, ordering within a column, and archiving |
| Import and export data | CSV import with column mapping, and `GET /api/contacts/export.csv` honouring the current filters |
| Control access | The Users module: roles, groups, sign-in rules, SSO |
| Track activity history | `GET /api/crm/history`, shown on the contact and company screens |
| Integrate via API | The same REST API every screen uses |
| Web forms that create records | Forms, part of this module rather than beside it: build one, paste the snippet into any site, and a submission arrives as a contact with the enquiry attached |
| Customise everything | Deal stages, outcomes, contact statuses, task types, deal categories, company sectors, tags — and custom fields on contacts, companies and deals |

## Two things the table used to be silent about

Both added on 2026-09-04, and worth recording as a lesson rather than only as
rows.

**Forms was built and not listed.** It existed as its own module, fed this one,
and appeared nowhere in this table — so nothing here was ever wrong, and the
audit still did not describe the product. A table of features can only be wrong
about the features it lists; checking the rows is not the same as checking the
set. The newsletter's audit had exactly the same hole, found the same week.

**Tasks were listed and under-described.** The row said tasks existed. It did
not say they could only hang off a contact or a deal, or that finishing one
meant opening a form — both of which came back from testing as gaps. A row that
names a feature without saying what it does is a row that passes an audit and
fails a user.

## Where this deliberately differs

**Customisation is settings, not a fork.** The reference is customised by editing
its code: add a field, replace a component, rebuild. That suits a product a
developer runs for a client, and not one a business self-hosts and updates.
So the same ground is covered by data a business edits on a screen — the
pipeline, the statuses, the sectors, and custom fields per record type.

Custom fields are defined in `crm_settings.custom_fields` and stored in a
`custom_values` JSON column on the record. Every value is checked against a
definition before it is written: a request body is not a schema, and without
that check any caller could write any key onto any record for ever.

**Defining them is Pro**, gated in `registerCrmSettings` rather than by a
`proOnly` middleware — `/api/crm/settings` also carries the stages, statuses,
sectors and task types, all free and all saved in the same request, so
refusing the whole route would take away six things to gate one. What is
refused is a request that would actually *change* the definitions; a Free
instance saving its pipeline sends them back untouched and goes through.

The comparison ignores key order. These come back from Postgres as `jsonb`,
which reorders keys, so a `JSON.stringify` comparison reports "changed" for a
list sent back exactly as it arrived — and every Free pipeline save would be
refused for touching nothing.

Existing definitions and values are untouched and still returned, because that
is the promise the Pro page makes about a lapsed licence.

**A deal becomes a quote**, and the route lives in Invoicing rather than the
CRM even though its URL names a deal (`POST /api/deals/:id/quote`). Raising a
quote correctly means the document numbering, the tax bands and the line
arithmetic, all of which are Invoicing's; a second implementation here would be
a second set of answers about money. The quote stores `dealId`, deliberately
without a uniqueness constraint — re-quoting after a customer asks for a change
is ordinary, and what the column buys is the deal being able to show what was
quoted against it.

A deal naming nobody is refused rather than quoted to nobody: a quote with no
customer cannot be sent, shared or converted, and finding that out after it is
raised is worse than being told at the time.

**Nothing invents its own people.** Users, roles and permissions belong to the
Users module. The CRM's "sales" are the platform's users.

**Email capture is a credential, and is treated as one.** The endpoint holds no
session — a mail provider posts to it — so the organization is named in the URL
and the secret compared in constant time. It is off until somebody turns it on,
rotating revokes what was handed out, and a message matching no contact is
dropped rather than filed against a guess: a private conversation on the wrong
customer's record is a breach with a paper trail.

**History is derived, not logged.** The timeline is assembled from notes,
activities, tasks and deals rather than written to a table of its own. A second
table would be a second thing to write on every path, and the first time
somebody forgot, the history would quietly start lying.
