# Users, roles, groups and signing in

The identity and access half of the platform, rebuilt against **Keycloak** —
learned from, not ported. Keycloak is built for an enterprise with an identity
team; what a business of under twenty people needs from it is four ideas, and
those are the ones taken.

Every module ties into this. No module invents its own accounts, roles or
permissions.

## The four ideas

| Keycloak | Here | Why it survives the shrink |
|---|---|---|
| Realm | The organization | One business per instance today; the boundary already exists. |
| Role | Role | A named set of permissions, built in or defined by the business. |
| Group | Group | A set of people that carries roles. An administrator thinks "the office", not "these six checkboxes". |
| Required actions & policies | Sign-in rules | Who must have a second factor, how long a session lasts, how short a password may be. |
| Identity providers | SSO connections | Google Workspace, Microsoft 365, or anything speaking SAML. |
| Sessions | Devices | What is signed in, and a way to end one. |

Deliberately not taken: LDAP federation, realm-per-customer, fine-grained
authorization services, user attributes as a data model. Each is a week of work
that a fifteen-person business would never open.

## How a permission is actually decided

Nothing new checks anything. `member.role` is comma separated; Better Auth
splits it and allows a permission if **any** of the roles grants it. So:

```
effective roles = the person's own role  ∪  the roles of every group they are in
```

is computed and written into `member.role` whenever it could have changed — a
role given directly, somebody added to or taken out of a group, a group's own
roles edited. `member.base_role` remembers which part was theirs to begin with,
because otherwise taking somebody out of a group could not tell what to leave
behind.

One function, `applyRoles`, so there is one answer and it is the same answer
every time. Every existing `requirePermission` call keeps working without
knowing groups exist.

## What the screens can do

- **People** — invite, change somebody's own role, reset a password, turn off
  their two-factor, sign out their devices, remove them. Each shows what a
  group grants them separately, because that is changed for the group rather
  than for one person inside it.
- **Groups** — create, name what they grant, put people in. Changing what a
  group grants applies now, not at the next sign-in: an administrator taking
  the books away from the fitters means now.
- **Signing in** — which roles must have a second factor, the shortest password
  the business accepts, how long somebody stays signed in. Two-factor is
  required *per role* because the person who can move money is not the person
  who clocks in on a shared tablet, and a business forced to choose one rule
  for everybody will choose none.
- **SSO connections** — pick "Google Workspace" or "Microsoft 365" rather than
  a protocol, give the email domain, paste the client id and secret. SAML for
  everything else.
- **Devices** — a person can end their own session without asking anybody; an
  administrator can end anybody's.

Everything that hands access around is written into the security log: who did
it, to whom, and when.

## Rules that are not negotiable

- **An identity provider says who somebody is, not what they may do.** Somebody
  arriving through SSO joins as a **member** and gets a role here, from
  somebody who can see what it means. The alternative puts the books in the
  hands of whoever administers the email system.
- **Disconnecting a provider keeps the people.** It stops sign-ins from that
  domain; it does not delete half the staff.
- **A group cannot carry a role nobody defined.** It would grant nothing and
  look like it grants something.
- **Nobody changes their own role.** An owner who demotes themselves has locked
  the business out of its own instance and nobody else can undo it.
- **Two groups cannot share a name**, and two SSO connections cannot claim one
  email domain.

## The one credential that is not sealed

Payment keys and other third-party credentials are sealed with AES-256-GCM
(`@sentrello/module-sdk` `secrets`). SSO client secrets are **not**: Better
Auth's SSO plugin owns those rows and stores its config as JSON text, and
nothing in its API takes an encrypted value. No route here ever returns one,
and the screen shows only whether a connection is configured — but a database
backup contains it in the clear. Worth revisiting if the plugin grows a hook
for it.

## Tables

`user_groups`, `user_group_members`, `security_policy`, `sso_provider`, plus
`member.base_role` on Better Auth's own membership table.
