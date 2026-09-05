# Users and access — design

Who is on this instance, what each of them may do, what any of them has done,
and how a business changes all of that without a terminal.

## Feature for feature

Rebuilt into our stack from the tool a company would otherwise run to hold its
accounts and decide what each of them may do. Reverse engineered rather than
ported: its data model, its screens and its vocabulary studied first, then
rebuilt here.

| The reference | Here |
|---|---|
| Users: search, create, detail with tabs | **People**, and a person's record with six tabs |
| Groups, with members and inherited access | **Groups**, with members and the policies each carries |
| Roles, and what each one grants | **Policies**, edited against the same statement the routes enforce |
| A user's effective access, resolved | The **Access** tab — resolved, and naming every route to each grant |
| Sessions: who is signed in, sign out one or all | **Sessions**, per person and across the business |
| Admin and login events, searchable | **Events** — administrative actions and sign-in attempts, filterable by actor, subject, action and time |
| Identity providers: OIDC and SAML sign-in | **Providers**, OIDC and SAML, connected from the module's own settings |
| Password policy, minimum length | Shortest password, on **Authentication** |
| One-time-password policy, per realm or per role | Two-factor required **per policy** rather than for everybody |
| Brute-force detection: lock an account after N failures for a period | Lockout, counted from the audit log rather than a counter beside it, clearable from the screen, a password reset, or the host |
| Session and token lifetimes | Stay signed in for, on **Authentication** |
| Reset a password from the admin console | Issue a new password, shown once |
| Reset a password from the host when locked out | `sentrello reset-password`, and `sentrello unlock` for the lock alone |
| Disable an account without deleting it | Suspend, keeping the invoices they raised |
| Deleting a user | Removing a member, refused for the last administrator |

**Screen for screen**, because the reference's own left-hand nav is the shape
an administrator already knows:

| The reference | Here |
|---|---|
| Users | Users → People |
| Groups | Users → Groups |
| Realm roles | Users → Policies |
| Sessions | Users → Sessions |
| Authentication | Users → Authentication |
| Identity providers | Users → Providers |
| Events | Users → Events |

## Where this deliberately differs

Each of these exists in the reference and is left out for a stated reason,
recorded so nobody has to re-derive it. Parity is the goal; parity with the
parts that would make this a different product is not.

**Acting as an identity provider.** OAuth2 and OIDC clients, client scopes,
service accounts, consent screens, protocol mappers, signing-key management.
Issuing tokens other applications trust is a different product with a different
threat model — key rotation, replay, consent revocation, and a compromise that
reaches every connected application rather than one instance. Sentrello
*consumes* single sign-on already. A business of under twenty people does not
need to *be* an identity provider.

**An authentication flow editor.** Rearranging execution steps in a graph is
powerful and, on a self-hosted instance with nobody to call, a way to lock every
administrator out permanently. A fixed set of policy toggles reaches the
outcomes a small business actually needs and cannot produce an unreachable
login.

**Fine-grained authorization services.** Resource servers, policies, scopes: a
second permission engine beside the one already enforced twice. Two authorities
over the same question is how the two quietly disagree.

**Realms.** One organization per instance is the model.

**Directory federation.** Not dropped — an optional module that syncs people
from a company's existing directory on a schedule, parented into this console
for the businesses that have it. Sync only: verifying a password against the
directory at sign-in needs an extension point in the authentication path, and a
fault in that seam locks everybody out of their own instance.

**Impersonation.** Its one genuine use is separating "their permissions are
wrong" from "the screen is broken for them", which the Access tab answers
without the risk. What it adds is the ability to *act* as somebody — to write a
record that says they wrote it — which every module that writes anything would
have to carry the distinction through, forever, or the record lies. If it is
ever built it belongs in an add-on, and read-only.

## Decided, 2026-09-03

Four differences from the reference, each put to James and answered. Recorded
with the reasoning so nobody re-opens them from scratch.

**Requiring a password change at next sign-in — not building it.** Two ways to
force a credential change already ship: issuing a new password ends every
session, and the host-side reset does the same. A third would add a column and
a branch on the sign-in path, which is the most safety-critical path in the
product, to reach an outcome both existing routes already reach.

**Passkeys — after the public launch, not before.** Time-based codes and backup
codes both work today, so this is additive rather than corrective. If people
ask for it once strangers are using the free tier, it is a well-scoped piece
with a clear design; if nobody does, it was rightly deferred.

**Email verification — built, as a setting that cannot lock anybody out.** Off
by default, on the Authentication screen beside the other sign-in rules. An
instance with no mail is the normal self-hosted case, and a rule that requires
an address nobody can verify is a rule that locks a business out of its own
software, so two things protect against that: the route refuses to switch it
**on** while no mail is configured (switching it **off** is always allowed —
the way out must never need the thing that is broken), and the owner's own
address is marked verified when they claim the instance, because reading the
setup token off the server's console proves it more strongly than a link in an
inbox would.

Checked last of the three sign-in refusals, after the lock and the suspension:
it is the only one the person can clear themselves, and the message says so.

The scope was larger than the setting implied — there was no verification flow
at all, no template and no sender — so a setting on its own would have been the
trap it was meant to avoid.

**Attributes on a person — HR's, when it lands.** An HR module is planned for
mid-2027. Job title, start date and emergency contact are its subject, and
putting them on a user record now would build half of it in the wrong module —
which HR would then have to absorb or contradict. The CRM's custom fields are
the pattern to copy when it does.

## One console, seven screens

Users is a section, not a page: **People**, **Groups**, **Policies**,
**Sessions**, **Authentication**, **Providers** and **Events**. It began as one
screen trying to be all seven, which is why the permission editor and the
sign-in rules used to sit under the list of employees.

`users` is still the id of the People screen rather than the section heading,
so a link or a bookmark to `/users` lands on the list it always did. The
heading is `users-console`.

People and Groups open records of their own. A person has six tabs — Details,
Credentials, Access, Groups, Sessions, Activity — and the tab is in the URL, so
a link to somebody's Sessions tab opens their Sessions tab. A tab id naming a
tab that no longer exists falls back to the first rather than to a blank panel,
because a bookmark outlives the thing it names.

## Three things, kept apart

Learned from the reference, which separates what this platform used to run
together:

- A **policy** (a role, underneath) is a named set of permissions.
- A **group** is a set of people.
- What somebody actually holds is their own policy plus the policies of every
  group they are in — computed, never typed.

`member.role` is comma separated. Better Auth splits it and allows a permission
if any of the named roles grants it, so groups arrived without a single
existing permission check having to know they exist. `member.baseRole` keeps
the one given directly, because without it, taking somebody out of a group
could not tell which of their roles was theirs to begin with.

## Two default sets, because a business thinks in two ways

A business that has to invent its own permission model before it can add its
second employee does not add its second employee. It gives everybody the
owner's role and hopes. So an organization starts with both sets in place.

**User policies — how senior somebody is.** Given to a person.

| Policy | What it is for |
|---|---|
| Admins | Everything, including settings and who else works here |
| Executives | Sees everything, changes little — the owner who is not doing the work |
| Managers | Runs the day: create and change, delete nothing in the books |
| Staff | Does the work: the diary, the customers, the paperwork |
| Customers | A customer of the business: their own invoices, nothing else |

**Group policies — what department somebody is in.** Carried by a group, so
moving somebody between departments is moving them between groups and nothing
else.

| Policy | What it is for |
|---|---|
| Sales | Wins the work: customers, quotes, invoices |
| Marketing | Talks to the market: customers and the shop |
| Accounting | Does the books: invoices, payments, the ledger |
| Customer Service | Answers the phone: the diary, orders, who people are |

The groups seeded alongside them are Admins, Sales, Marketing, Accounting,
Customer Service and Customers.

**Managers cannot delete in the books.** Not an oversight: a manager who can
void an invoice can void the record of an argument they lost.

**Customers is deliberately tiny.** Seeing only *their own* invoices is not
something a role can express — it is row-level, and the portal routes enforce
it by resolving the account to a contact and filtering to that contact. RBAC is
the outer fence, not the whole of it.

## The defaults are data, and can be thrown away

Every one of them is editable and deletable by the business that owns it, which
is the point of seeding them rather than compiling them.

Three names are the exception, and it is not arbitrary: Better Auth reserves
the names of roles compiled into the product — `admin`, `staff`, `accounting` —
and refuses to store one of the business's own by the same name. Those appear
in the list marked as shipped and offer **Copy** instead. A business that wants
a Staff who may also send invoices takes a copy, changes it, and assigns that.
`admin` would stay whatever happened: a business able to delete it could lock
itself out of its own machine.

**Seeding happens once, and stays undone.** A marker on the organization
records that it ran. A business that threw away five of the six default groups
must not find them back tomorrow, and one that rewrote Managers must not have
the edit reverted — both of which a "create anything missing" seed would do
every time it ran. It runs on the first read of the access screen, under an
advisory lock, because an organization is created by three different paths and
a hook on one is a hook the other two skip.

Role names are stored lower case — Better Auth normalises them — so "Customer
Service" is `customer service` in the table and is capitalised again for
reading.

## Built for twenty-five, and not broken at five hundred

Most instances have twenty-five people. Some have five hundred, across three
sites. The membership limit is 500 rather than the 100 it was, and the people
list is searched and paged **on the server** — filtering in the browser means
fetching everybody first, which is the thing being avoided. The group pickers
ask for a larger page, because a picker that cannot find the two-hundredth
person cannot put them in a group.

## What somebody may actually do, and where each part came from

The Access tab answers the question an administrator actually has, which is not
"what roles does this person hold" but "what can they do". It resolves the
union of the policy given to them directly and the policies carried by every
group they are in, and for each granted action it names **every** route to it.

Naming every route is the point rather than a detail. Somebody whose own policy
and whose group both grant `invoicing:read` keeps it when they leave the group,
and an administrator who cannot see the second source removes the wrong thing.
A resource nobody granted is shown saying so rather than left out, because the
absence is the answer to "why can't they do that".

For the two role names Better Auth compiles — `admin` and `customer` — a
business's own stored row **adds to** the compiled definition rather than
replacing it. The compiled statements are a floor, which is what the permission
check itself does; a screen that said otherwise would report that an owner may
do almost nothing while they retain full control.

## What has happened, kept as a log

Every administrative action and every sign-in attempt is recorded: who did it,
to whom, and when. The Events screen searches and filters that log; the Recent
changes card on People shows the administrative slice of it, deliberately
excluding sign-in noise, because twenty-five bot attempts would otherwise evict
every real change from a card that exists to show them.

**Lockout is derived from the log rather than stored beside it.** Repeated
failures against an address lock it, counted from the recorded attempts within
a window. Two pieces of state describing the same fact eventually disagree, and
this one would disagree at the moment somebody phones to say they cannot get
in; counting the events means the lock and the reason for it are the same
record. A lock lifts itself when the failures that caused it age out — which
matters because on a self-hosted instance the locked-out person is usually the
only administrator — and it can be turned off entirely by setting the attempt
count to zero.

The log is pruned to whatever retention the business chose, and the prune
records itself. Retention cannot be set shorter than the lockout window: a
prune reaching inside that window could delete either the failures that caused
a lock or the success that would clear it, which would make the answer
arbitrary in both directions.

## Suspending somebody, rather than deleting them

A person who has left should stop being able to sign in without their invoices
losing their author. Suspending keeps the member row and everything it wrote,
ends their sessions, and refuses every sign-in path — not only the password
door, but the second-factor doors and any identity provider, because a
suspension enforced on three of five paths is not a suspension.

Nobody may suspend themselves, and the last administrator may not be suspended:
an instance with no administrator cannot be recovered through the browser.
Administrators who are themselves suspended do not count toward that total, or
two calls would empty the business of anybody able to sign in.

## What this console must never make somebody use a terminal for

An administrator whose bookkeeper has left, or whose foreman has lost the phone
with his authenticator on it, is usually the owner of the business. Sending
them to SSH was never going to work, so the console can issue a new password,
revoke a second factor, end every session somebody has open, unlock an account
that locked itself, and remove a person outright.

The one case the browser cannot answer is the administrator locked out of their
own instance with nobody left to ask. That has two commands on the host, and
they are the reason the lock is allowed to be strict:

```bash
sentrello reset-password you@yourbusiness.com
sentrello unlock you@yourbusiness.com
```

Both record what they did, so a password set from the host is as visible in the
log as one set from the screen. Anyone who can run them already has shell on
the machine holding the database; what they save is doing it with a SQL client
and a hashing library.

The Authentication screen names the things about a deployment that are
invisible until the day they matter: which header this instance trusts for the
client address and what the current request resolved to — get that wrong and
every sign-in looks like it comes from the proxy, so lockout locks everybody at
once — and whether the base URL is `https`, because a session cookie marked
`Secure` is not sent over plain HTTP and sign-in will appear to succeed and do
nothing.

The permission matrix is generated from the same statement the server enforces,
so a module added tomorrow appears without anybody remembering to add it. A
hand-written list would drift, and the drift would be silent: a resource nobody
can grant is a feature nobody can use.

Two-factor is required by **policy**, not by person: the one who can move money
is not the one clocking in on a shared tablet, and a business forced to require
both will require neither.
