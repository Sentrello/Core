# Invoicing — design

Rebuilt from a focused invoicing product on the same stack we run — Bun, Hono,
React — rather than from a billing corner bolted onto
something larger. Reverse engineered, not ported: its data model, its
workflows and its vocabulary studied first, then rebuilt in our architecture.

What we take is the shape of the product. What we do not take is its storage
decisions, because two of them are wrong for a system that keeps books.

## Two deliberate divergences from the reference

**Money is integer cents.** The reference stores every amount as SQLite `REAL` — a
float. `0.1 + 0.2` is the standard demonstration of why that is a bad idea for
money, and an invoicing product is the last place to accept a rounding error
nobody can explain. Every amount here is an integer number of cents and every
tax rate is basis points (`875` = 8.75%), as everywhere else in Sentrello.

**Nothing invents its own people.** The reference ships its own `customers`,
`users`, `user_permissions`, `tags` and `activity_log`. Sentrello already has
all five, and a module that keeps a second list of who works here is a second
place to forget to remove somebody who left. So:

| The reference | Here |
|---|---|
| `customers` | CRM contacts and companies |
| `users`, `user_permissions` | the Users module, and `requirePermission` |
| `tags`, `item_tags` | the CRM's tags and taggables |
| `activity_log` | the CRM's activities |
| `portal_tokens` | `contacts.portal_token`, which already exists |

Invoicing owns only what is genuinely its own: the documents, the tax
definitions, the templates they are rendered with, the payments against them,
and the schedules that produce them.

## What the module is

The full lifecycle of a document that asks somebody for money.

- **Invoices** — draft → sent → partly paid → paid → void, with duplicate.
  Line items with quantity, unit, unit price and a tax rate each; an
  invoice-level discount as an amount or a percentage; notes and payment terms.
- **Quotes** — the same document before it is owed. Shareable, acceptable, and
  convertible into an invoice — or into several, when the work is billed in
  instalments.
- **Subscriptions** — plans, subscribers, and the lifecycle a subscription
  business actually spends its time on: trials that bill on the day they end,
  pauses that resume from today rather than raising three invoices for the
  months nobody used, plan changes that take effect at the next invoice, and
  cancellations that keep the period already paid for. A plan is a catalogue
  item with a billing period on it, priced and taxed exactly as it would be on
  a one-off invoice — a second catalogue would be a second answer to what a
  thing costs. The subscriber's price is copied at signup, so raising a plan's
  price does not silently rebill everybody who joined last year.

  **This is where subscriptions live for the whole platform.** The Shop sells
  things that are bought once; anything billed on a repeat is Invoicing's,
  because it already owns the schedule that raises the invoice and the ledger
  it posts to. Two things believing they own a renewal is how a customer is
  charged twice.
- **Recurring** — a template invoice, a frequency and a next run date. The
  template is a real draft invoice rather than a form of its own, so what the
  customer receives is a document somebody can open and correct first. Every
  N days, weeks, months, quarters or years; an optional end date; and
  `auto_send` decides whether raising it also sends it.
- **Payments** — full and partial, by whatever method, recorded against the
  invoice and dated when the money arrived rather than when somebody typed it
  in. The balance is what is owed, not what was billed.
- **Reminders** — rules offset from the due date, before and after, each with
  its own wording, and a log of what was sent so nobody is chased twice.
- **Late fees** — a charge added by rule rather than by remembering.
- **Public links** — a share token per document, with a read receipt, so the
  business can tell whether a customer opened it.
- **Letterheads** — a logo, a colour, a paper size and the business's own
  wording above the lines and below the totals, applied to the document a
  customer opens. Saving it as a PDF is the browser's own print dialogue: every
  browser has one, it produces a better document than a headless renderer we
  would have to ship and patch, and the page reads correctly without it.
- **Statements** — everything a customer owes over a period, as one document
  to send them.

## Tax, and why it is shaped this way

The reference carries a per-invoice tax breakdown (`invoice_taxes`) alongside the
per-line rate, with an EN 16931 `category_code` on each band. That looks like
duplication until you need to produce a compliant e-invoice, at which point it
is the only structure that answers "how much was taxed at each rate, and under
which category" without recomputing it from lines that may since have changed.

**E-invoicing itself — ZUGFeRD, XRechnung, PEPPOL — is deliberately not in
this pass.** The EU is a target market and it will be needed; what it must not
need is a migration. So the tax tables are shaped for it now and filled in
later: the breakdown is stored, category codes are stored, and the transport
is a separate piece of work.

## Templates are branding, not markup

The reference stores a HTML body with a template language in it, per template and renders it into the page
the customer opens. We store fields — logo, colour, paper size, two notes — and
escape every one of them.

The reason is that the public document is served from the application's own
origin. A `<script>` saved into a template by anybody holding
`invoicing:update` would run with an administrator's session the first time
that administrator previewed the invoice, which turns a permission to edit
invoice wording into a permission to do anything. The colour is checked against
`#rrggbb` for the same reason: it is written into a stylesheet, and
`red;}body{...` is an ordinary-looking string that rewrites the page.

If arbitrary layout is ever genuinely needed, it belongs in a template *file*
shipped with a module — reviewed like code, because that is what it is.

**Three of them, from 2026-08-25.** A colour and a logo over one layout gave
every business the same document in a different shade, which is not really a
letterhead. There are now three layouts — classic, modern and compact — and a
template names one. The stylesheet behind each is ours, written once, so a
business gets a genuinely different-looking document without being handed a box
that runs. The settings screen offers all three as samples with a sketch of
what each looks like, one press to take one, and the custom form underneath for
everything after that. A document can name its own letterhead, which the server
has always honoured and no screen had ever offered.

The validator and the stylesheets are in different files by necessity, so a
test asserts that every layout name the validator accepts has CSS behind it — a
template saved with a layout nothing renders falls back to plain, and a business
would have no way of seeing why.

## Parity against the reference, checked 2026-08-25

Walked feature by feature against the reference's own documentation and its route
and page list. What follows is what it has and we did not; each is either built
or has a reason beside it.

| The reference | Here |
|---|---|
| Early payment discount (Skonto) | **built** — see below |
| Consolidating several drafts into one invoice | **built** — see below |
| Batch operations on a list | **built** — invoices can be selected and deleted together |
| CSV export of invoices, customers, products | **built** — invoices and quotes export the filtered list; customers already did, in the CRM |
| Tags on invoices, with list filtering | **built** — the CRM's tags, on invoices and quotes, with `?tagId=` on the list |
| An exchange rate stored on a document | **built** — and it fixed a real one: the sales side was posting foreign invoices at face value |
| Payment terms as a selection, not a sentence | **built** — a list in settings, and choosing one sets the due date |
| A unit on a line, from a list | **built** — the same settings screen; the catalogue picks from it too |
| Products with a code, a description and a kind | **built** — the catalogue had the columns and the screen never offered them |
| Restoring a deleted invoice or quote | **built** — the route existed; nothing called it |
| Splitting a quote into instalments | **built** — see below |
| Online payment from the shared link (Stripe, PayPal) | **gap** — the largest one left; belongs in the module's own settings, the way any third-party integration does |
| Three sample templates to start from | **built** — three layouts we ship, plus the custom form |
| A template chosen per document | **built** — the server always honoured it; the form now offers it |
| Saved filters, column visibility, sortable headers | **gap**, list ergonomics rather than function |
| Command palette / global search | the shell's, not the module's |
| Onboarding wizard | the platform's setup flow |
| Database backup button | the host's runbook, not a screen in a module |
| Multi-language | the shell's, once, not per module |
| E-invoicing: ZUGFeRD, XRechnung, PEPPOL, Factur-X | deliberately deferred; the tax tables are already shaped for it |
| Its own expenses, reports, users, tags, activity log, OIDC, API tokens, webhooks | the platform's or Accounting's — see below |

**Early payment discount — built.** It is the one that moves money. The reference lets an
invoice offer a percentage or a fixed amount off if it is settled within N days
of issue; the document shows the saving and the deadline, and recording a
payment inside the window prefills the discounted balance and settles the
invoice. Outside the window the option is refused. Deleting such a payment puts
the invoice back where it was.

**Instalments — built 2026-08-25.** An accepted quote can become a deposit and
stages rather than one invoice. Without it a business raises the deposit by
hand and remembers the rest, which is how a stage goes unbilled.

The split is done on the taxable base of each tax band, not on the gross. Each
instalment gets one line per band, so a mixed-rate quote produces invoices whose
lines agree with the tax printed under them, and the shares add back up to the
quote exactly — the last one takes the odd penny, which is why no "rounding
adjustment" line is needed. A discount on the quote is already inside that base,
which is what carrying it over proportionally means here.

They are drafts. An instalment due in ninety days is not money the business is
owed yet, and issuing it now would put the revenue in this month's books and
start the overdue clock on work nobody has done. Issuing one posts it, the same
as any other invoice.

**Terms and units — built 2026-08-25.** Both were free-text boxes. That is how
one business ends up with "hour", "hours", "hr" and "Hrs" across four invoices,
and with payment terms that say thirty days beside a due date somebody set to
next Tuesday. Terms are now a list with a number of days against each, and
choosing one sets the due date; units are a list the catalogue picks from too.
Both are editable, because a business that sells by the cubic yard needs the
cubic yard, and the arrangement nobody else has still has to be writable in the
customer's own words.

**Consolidation — built.** It merges several *drafts* for one customer, in one currency,
into a new draft: lines copied in order, grouped under the invoice number they
came from, with a subtotal per source. Mixed currencies are rejected.

## What is not taken from the reference

- **Its own expense tracking.** Sentrello's Accounting module already owns
  money in and out and the double-entry ledger. Invoicing posts to that ledger;
  it does not keep a second set of numbers.

- **Its reports.** The reference ships a tax summary, A/R aging and a profit and
  loss. Sentrello already has all three — the first two in Pro, profit and loss
  in Free beside the balance sheet — computed from the ledger rather than from
  the invoice table — which is the right source, because the
  ledger is where every financial event lands and invoices are only one of
  them. A second set in Free would be the same numbers derived a second way,
  and two answers to "what tax do I owe" is worse than one.
- **SQLite, and its floats.** See above.
- **Its OIDC, API tokens and outgoing webhooks.** The platform owns
  authentication and integrations; a module adding its own is the same mistake
  as a module adding its own users.
- **i18n as a module concern.** Translation belongs to the shell, once, not to
  each module separately.
