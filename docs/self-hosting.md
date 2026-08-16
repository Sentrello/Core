# Running Sentrello yourself

Everything here applies to the Free tier, which is this repository. You need a
Linux server with Docker or Podman, a domain name, and about twenty minutes.

```bash
curl -fsSL https://get.sentrello.com | bash
```

The installer asks three questions, generates its own database password and
signing secrets, starts PostgreSQL and the app, and runs the migrations. It
prints a **setup token** at the end — the first screen asks for it, which is
what stops somebody who finds your address before you do from claiming your
instance.

The app listens on `127.0.0.1:3000`. It is deliberately not exposed: put a
reverse proxy in front of it.

---

## What it talks to

A Free instance can run forever without contacting us at all. There is no
registration, no key, and nothing that expires.

| Call | Where it goes | Whose account |
|---|---|---|
| Everything the app does | your own instance | yours |
| Email, if you configure it | Resend or your SMTP server | yours |
| Card payments, if you enable them | Stripe or PayPal | yours |
| Usage report, **only if you say yes** | sentrello.com | ours |

The usage report is the only thing that ever reaches us, it is off unless you
answer yes at install, and you can turn it off afterwards in Settings. It
sends: the version you run, whether you are Free or Pro, which modules are
loaded, and a band for how many people use it (`1`, `2-5`, `6-10`, `11-20`,
`21+`). It never sends customer records, names, addresses, figures, or anything
that identifies your business.

Your database is on your server. Query it, back it up, move it. If this project
disappeared tomorrow your instance keeps running.

---

## Putting TLS in front of it

Any reverse proxy works. Two that people use:

**Caddy**, which gets a certificate on its own:

```
app.yourbusiness.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**, with certbot:

```nginx
server {
    server_name app.yourbusiness.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    client_max_body_size 10m;
}
```

Then `certbot --nginx -d app.yourbusiness.com`.

Whatever you use, the address must match `SENTRELLO_BASE_URL` in
`/opt/sentrello/secrets/.env`. Links in emails and on customer-facing pages are
built from it, and a mismatch is why a customer receives a link pointing at
`localhost`. Settings tells you when the two disagree.

---

## Email

Optional, and worth doing: without it, a password reset has nowhere to go and
invoices cannot be emailed. Either of these in
`/opt/sentrello/secrets/.env`, then `sentrello restart`:

```sh
RESEND_API_KEY=re_...
EMAIL_FROM="Your Business <billing@yourbusiness.com>"
```

```sh
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="Your Business <billing@yourbusiness.com>"
```

If mail is not configured and you are locked out, use the terminal instead:

```bash
sentrello reset-password you@yourbusiness.com
```

---

## Backups

```bash
sentrello backup                 # a dump you can keep
sentrello restore backups/<file> # put one back
```

Two things worth knowing. Every update takes a backup first and **refuses to
proceed without one** — an update that cannot back up is an update that should
not happen. And a backup on the same disk as the database is not a backup:
copy them somewhere else, on a schedule, and try a restore before you need one.

The whole instance is `/opt/sentrello`. The database dump plus that directory
is everything.

---

## Updating, and going back

```bash
sentrello status     # what you are running, and whether anything is newer
sentrello update     # takes a backup, pulls, migrates, restarts
sentrello rollback   # the previous version, if the new one is wrong
```

Both are also buttons in Settings, applied by a small agent on the host so the
app never has to touch the container engine itself.

Rollback puts the previous release back **against the newer database**, which
works because migrations here are additive: an older release ignores columns it
does not know about. Nothing you entered since the update is lost. That is the
point — an instance that has taken a day of invoices must not throw them away
to fix a display bug. If you want the data back as it was too, restore the
backup the update took.

---

## When something is wrong

Start here:

```bash
curl -s localhost:3000/healthz
sentrello logs
```

`healthz` answers without a login and tells you the version, whether the
licence is valid, which modules loaded, and — importantly — which ones
**failed**. A module that will not load takes all of its features with it, so
`modules_failed` being empty is the first thing to check.

The dashboard shows the same machine from the inside: disk free, database size,
how long it has been up. A self-hosted business owns the server and nobody else
is watching it, and the usual first sign of a full disk is a backup that
silently stopped working.

| What you see | Usually |
|---|---|
| Links in emails point at `localhost` | `SENTRELLO_BASE_URL` does not match your domain |
| Customers cannot open the portal | the same |
| A password reset email never arrives | no mail configured — see above |
| `modules_failed` is not empty | that module's bundle is broken; the message says why |
| The app will not start after an update | `sentrello rollback`, then tell us what happened |

---

## Reporting something

Bugs and questions: open an issue. Please include the `healthz` output and what
you were doing.

**Security problems: do not open a public issue.** Email
`security@sentrello.com` with what you found and how to reproduce it.
