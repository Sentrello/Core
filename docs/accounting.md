# Accounting — design

Rebuilt into our stack from the tool a small business would otherwise use to
keep its books. Reverse engineered, never ported: its licence forbids using its
code in a competing product or an accounting service, which is exactly what
this is, and
its stack — PHP and Laravel — is not ours. What was studied is the shape of the
product: its vocabulary, the order somebody does things in, and which figures a
small business is actually asked for.

## The split

Accounting is one module with one nav entry, and the licence decides how far it
goes — the same pattern the dashboard uses. The Free half never degrades when
Pro is absent, and Pro is not a second module a customer has to find.

**Free — what a business genuinely cannot do without:**

- the double-entry ledger and the chart of accounts everything posts to
- money in and money out, where no invoice was involved
- a profit and loss for a period, and a balance sheet as at a date
- the journal itself, read-only

**Pro — the rest of parity with the reference:**

- bills and vendors, approved into Accounts Payable and paid from a bank
  account, with tax withheld where a regime requires it, and bills that repeat
  on a schedule
- bank accounts, transfers, imported statements and reconciliation
- taxes for the four markets we sell into, including compound rates and
  whether tax paid on a purchase comes back
- multi-currency: rates stored per day, documents raised in any currency, and
  the difference when a rate moves posted as an exchange gain or loss
- budgets against actuals, by month or for the year
- the full report set — cash flow, tax summary, trial balance, income and
  expense by category, aged receivables and payables, and the ledger as a CSV

The Pro routes are registered on every instance and answered only where
`entitled({ tier: "pro" })` holds; on a Free instance they return 404, because
an endpoint a licence has not bought does not exist. The screen asks
`/api/_meta` for the tier and offers the four extra tabs — Bills, Banking,
Budgets, Tax and currency — only where it says Pro.

Tax rates themselves are edited on the Invoicing settings screen, because the
name, the rate and the category are what appear on a document. Accounting's own
tax screen sets the parts that change the journal entry rather than the
document: whether a rate compounds, is withheld, or comes back on a purchase —
and it installs a regime's rates as a starting point.

## The ledger is the only source of truth

Every report here is read from journal entries and nothing else. Not from
invoices, not from the transactions table, not from the shop's orders — because
the journal is the one place every financial event lands, and a report built
from a document table answers a slightly different question each time a module
is added.

That has three consequences that shape the module:

**Everything posts, or it did not happen.** Recording money is one function,
`createTransaction`, used by every endpoint that can record it. Two paths that
write the books are two chances for one of them to skip the journal, and a
transaction that never reached the ledger is the worst kind of wrong: it shows
on the screen and in no report.

**Entries carry the date of the event, not the date of the typing.** A receipt
dated the 28th entered on the 3rd belongs to the month it happened in, or every
period report changes depending on when somebody got round to it.
`postJournalEntry` takes the date for exactly this reason.

**Nothing is deleted.** Undoing a transaction posts the opposite entry and
leaves both, so a business that printed a report last week can still explain
the figure on it. Editing an amount is the same thing: a reversal, then the new
entry. An account with postings against it cannot be deleted either — it is
archived, because a journal line without an account is a report that no longer
adds up.

## What the chart of accounts is, and is not

It is a tree — an account may sit under another, because "Utilities under
Premises" is how somebody thinks about it even when the numbering already
implies it. The screen offers only accounts of the same type as a parent, and
the server refuses a loop however far round it goes. Codes follow the
convention every accountant expects: 1000s assets, 2000s liabilities, 3000s equity, 4000s income, 5000s cost
of sales, 6000s overheads. `POST /api/accounts/standard` fills in a short
starting chart and never adds the same code twice, so pressing it again after
six months of trading is safe.

It is **not** a separate categories table. The reference keeps categories beside its
accounts; in double-entry the expense account *is* the category, and a second
list is a second answer to "what did we spend on rent".

An account's type is fixed once anything is posted to it. Changing an expense
account into an asset does not move the postings already on it — it silently
rewrites every report that has ever been run, including ones already filed.

## Money in and out, beside invoices rather than instead of them

Invoices and their payments have their own tables because they are documents
somebody sends. `transactions` is everything else: cash over the counter, a bank
charge, a supplier paid on the spot. Both post to the same journal, so the
reports do not care which one a figure came from.

`/api/expenses` still exists and still has its old shape. Projects links a cost
to a job through it and a customer's own scripts may call it, so it reads and
writes the same rows as the transactions screen. One store, two names — never
two stores.

## Bills are not invoices with the sign flipped

A bill arrives with the supplier's own reference on it, ages into a different
report, and is settled from a bank account rather than into one. One table with
a direction flag would put a supplier's demand one wrong query away from a
customer's statement, so `bills` is its own document — but it shares the
arithmetic: `documentTotals` and `invoiceStatus` are the same functions the
sales side uses, because "paid when the payments reach the total" is one rule
whichever way the money goes.

A bill posts nothing until it is approved. A draft is somebody typing; an
approved bill is a debt the business admits to, and that is the moment it
belongs in Accounts Payable.

A repeating bill produces a **draft** each period and stops there. Invoicing
raises and sends its recurring documents unattended because those are the
business's own claims; a bill is somebody else's, the figure is often not last
month's, and posting a liability nobody has looked at is how a set of books
fills up with amounts the business never agreed to.

## Tax that comes back, and tax that does not

VAT and GST/HST are reclaimed, so tax on a bill is debited to the tax account —
it reduces what the business owes the authority. US sales tax is not
reclaimable: it is part of what the thing cost, so it is added to the expense
account instead. The distinction is a column on the rate (`recoverable`), not a
guess made from the country, and posting the second as the first would overstate
both the expense claim and the refund.

Withheld tax is the other direction: the supplier is paid less and the
difference is owed to the authority. Accounts Payable is debited in full either
way, because the debt is settled either way.

## More than one currency, without unreadable books

Documents may be raised in any currency. The ledger is kept in exactly one,
because a report that adds euros to dollars is not a report — so every posting
is converted on the way in, at the rate that applied on the document's own date.

Rates are stored rather than fetched. A rate has to be the one that applied
when the document was raised, not the one a service returns today, or last
year's accounts change every time somebody opens them. A foreign bill with no
rate recorded is refused rather than posted at 1:1: a plausible wrong number in
the books is one nothing downstream ever questions.

A bill's liability is cleared at the rate it was recorded at, and the money
leaves at the rate on the day it is paid. The difference is neither a cost the
business chose nor income it earned, so it lands in Exchange Gains and Losses —
and without somewhere for it to go, the payment entry would not balance at all.

## The paper behind a figure

Bookkeeping is half arithmetic and half evidence: an inspector, an accountant
and a bank all ask for the receipt rather than the entry. A transaction or a
bill can carry one, stored through the module SDK's attachment helpers — the
name on disk is generated so nothing a caller sends can climb out of the
directory, and files come back as downloads with a neutral content type so an
uploaded `.html` cannot run against this origin as the person who opened it.

Detaching a receipt clears the row's reference and leaves the bytes alone.
Deleting them on a mis-click is how a business loses the only copy of a
document it is required to keep for years; nothing about a wrong figure is
worth destroying evidence over.

## Why the permission is still called `bookkeeping`

The module was called Bookkeeping until it grew into this. The permission
resource kept its name because it is written into every custom role a business
has already saved, and a statement that no longer knows a resource is a role
that stops loading — which would lock people out of the module the rename was
meant to describe better.

## Parity against the reference, checked 2026-09-03

Walked area by area against the reference's own documentation and this module's
route list. The reference is a mature small-business accounting product; this
is the same job rebuilt on our stack, split across Free and Pro as §1 sets out.

| The reference | Here | Half |
|---|---|---|
| Double-entry ledger and chart of accounts | `postJournalEntry`, Σdebits === Σcredits or it throws; `/api/accounts`, `/api/accounts/standard` | Free |
| Journal, readable | `/api/journal`, read-only — the ledger is the source of truth, not a cache of one | Free |
| Income and expenses recorded outside a sale | `/api/transactions`, `/api/expenses` — money in and out where no invoice was involved | Free |
| Profit and loss; balance sheet | `/api/reports/profit-and-loss`, `/api/reports/balance-sheet` | Free |
| Bills from suppliers, approved and paid | `/api/bills`, `/api/bills/:id/approve`, `/api/bills/:id/payments`, `/api/bills/:id/void` | Pro |
| Recurring bills | `/api/recurring-bills`, and a nightly job that copies each template when due | Pro |
| Vendors | `/api/bills/vendors` — a vendor is a contact this business buys from, held by the CRM, not a second list of people | Pro |
| Bank and cash accounts | `/api/bank-accounts` | Pro |
| Transfers between accounts | `/api/transfers` | Pro |
| Importing a bank statement, and reconciling it | `/api/bank-imports`, `/api/bank-transactions`, `/api/bank-transactions/:id/match`, with suggested matches | Pro |
| Taxes, including compound rates | `/api/accounting/taxes/:id`, `/api/accounting/taxes/presets` — and whether a rate compounds, is withheld, or comes back on a purchase | Pro |
| More than one currency | `/api/accounting/currencies`, rates stored per day, and the movement posted as an exchange gain or loss | Pro |
| Budgets against actuals | `/api/budgets`, `/api/budgets/:id/lines`, `/api/budgets/:id/actuals` | Pro |
| Reports: cash flow, tax summary, trial balance, by category, aged receivables and payables | The six `/api/reports/*` routes above, plus the ledger as CSV | Pro |
| Attachments on a transaction | The document behind a figure, reachable from the entry it belongs to | Pro |

**Where the shape differs, and why.** The reference is one product that owns
its own customers, vendors, items, users and roles. Here those belong to the
modules that already own them — which is the whole argument for a platform
rather than a suite of separate applications, and is set out under *What is not
taken from the reference* below.

The other difference is the Free/Pro line. The reference is one product at one
price; this is split so a business that only needs a ledger, money in and out,
and two statements never pays for bank reconciliation it will not use. The Free
half is not a trial: it does not degrade when Pro is absent.

## What is not taken from the reference

- **Its own customers and vendors.** The CRM already owns contacts and
  companies. A vendor is a contact this business buys from, not a second list of
  people.
- **Its own users, roles and permissions.** The Users module owns all three.
- **Its own items.** Products live in Shop; invoicing has its own lines.
- **Its module store and updater.** Sentrello has one, and a module bringing a
  second way to install things is a second way to install the wrong thing.


## The money list, 2026-08-28

The reference's transaction list has tabs, a date range and a running total. Ours
had none of them — and the server had taken `kind`, `from` and `to` since it
was written. Nothing sent them, so the only view of the books was everything,
newest first.

It now has the tabs (everything, money in, money out, transfers), a date range,
a search over what the line says, and the total of what is on screen. That last
one is the answer somebody is actually after when they filter to "fuel, this
quarter", and adding the rows up by hand off the screen is how a business gets
a different figure every time it looks.

Searching is done where the data is. Filtering in the browser means fetching a
year of entries in order to look through them.
