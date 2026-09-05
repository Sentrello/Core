# Dashboard — design

The first screen after signing in, and — since 2026-08-25 — the only place
reports live.

## A dashboard is a collection of reports

There used to be a Reports screen in Pro beside a dashboard full of figures.
That is two places to look for one answer, and whichever somebody opened first
decided which numbers they believed. Reports is not a module and not a screen:
every report it drew is now a dashboard panel, arrangeable with the rest.

Nothing was dropped in the move. The two panels that only existed on Reports —
the balance sheet, and the named list of who owes you rather than the buckets —
came across as `balance-sheet` and `who-owes`.

The figures are all read from the ledger. If one looks wrong, the journal is
wrong, and that is the right place to look. The balance check is shown rather
than hidden: a balance sheet that does not balance is the single most important
thing the panel can say.

## One screen, two dashboards

Free answers "what needs doing today" — money earned and not received, a quote
nobody answered, a follow-up that was due yesterday. Pro answers "how is the
business doing", which is a slower question, and lets somebody arrange it into
tabs. One module with two faces rather than two files, because two files drift
and the half nobody looks at would be the Free one — the half every new
instance opens first.

## Modules speak for themselves

The dashboard used to reach into the tables Core owns, because those are the
ones it can name. That does not extend: Shop and Booking live in a private
repository and Core must not import them, so anything they know would never
reach the first screen a business looks at.

A module registers a summary instead — `ctx.registerSummary({ id, label,
requires, load })` — and the dashboard draws whatever is registered, in
whatever combination this instance's licence loaded. It knows none of them by
name. A module that is not installed contributes nothing, which is the right
answer rather than an empty panel.

Three rules the endpoint follows, each of which is a bug it would otherwise
have:

- **Each summary's permission is checked separately.** A bookkeeper's first
  screen should not be missing everything an owner sees, and an owner's should
  not fail outright because one panel was not theirs.
- **A summary that throws is left out.** A module that cannot count itself must
  not stop the others being counted.
- **Money stays in cents all the way to the browser.** A figure formatted on
  the server is formatted in the server's locale and currency, and this one
  belongs to whoever is reading it.

Registered today: Invoicing, Shop, Booking and Documents. Each also has its own
front page — the same figures plus the lists somebody acts on — because a
module dashboard that is only totals is a screen people look at once.

## What is deliberately not here

**A "welcome" stepper.** A panel explaining the product to somebody who has
already bought it is a panel they scroll past forever, and it takes the space
the actual work should occupy.

**A charting library.** The charts are computed on the server and drawn as
plain SVG, or as divs inside a module bundle. A dependency in a public
repository, and in every bundle a customer downloads, for a polyline and some
rectangles.
