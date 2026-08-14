import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  muted,
} from "../lib/ui";

interface LicenseResponse {
  tier: string;
  valid: boolean;
  reason: string | null;
  modules: string[];
  seats: number | null;
  instanceId: string | null;
  tokenExpiresAt: string | null;
  graceUntil: string | null;
  modulesLoaded: string[];
  failedBundles: { name: string; reason: string }[];
}

interface SettingsResponse {
  business: {
    name: string;
    slug: string;
    address: string;
    taxId: string;
    taxIdLabel: string;
    paymentInstructions: string;
  };
  instance: { baseUrl: string; baseUrlMatchesRequest: boolean };
  email: { configured: boolean; from: string | null };
  payments: {
    stripe: {
      configured: boolean;
      webhookConfigured: boolean;
      testMode: boolean;
      invoiceWebhookUrl: string;
      shopWebhookUrl: string;
    };
    paypal: {
      configured: boolean;
      webhookConfigured: boolean;
      environment: string;
      shopWebhookUrl: string;
    };
  };
}

/** Green when it is set up, amber when it is not — never a bare boolean. */
function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span
      className="text-sm font-medium"
      style={{ color: ok ? "var(--color-success)" : "var(--color-warning)" }}
    >
      {ok ? yes : no}
    </span>
  );
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <button
        type="button"
        className="w-full truncate rounded border px-2 py-1 text-left text-xs"
        style={{ borderColor: "var(--border)" }}
        onClick={() => navigator.clipboard?.writeText(value)}
        title="Copy"
      >
        {value}
      </button>
    </div>
  );
}

interface UpdatesResponse {
  current: string;
  latest: string | null;
  rollbackTo: string | null;
  updateAvailable: boolean;
  canApply: boolean;
  status: { state: string; message?: string; version?: string; at?: string };
}

export function Settings() {
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  // Held together, because they are saved together: partial identity on an
  // invoice is worse than none, since it looks deliberate.
  const [details, setDetails] = useState<Record<string, string> | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });

  const licence = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseResponse>("/api/license"),
  });

  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () => api<UpdatesResponse>("/api/settings/updates"),
    // While the host is working, the only way to see progress is to ask again.
    // Idle instances ask once and stop, so this is not a background poller.
    refetchInterval: (q) =>
      q.state.data &&
      ["requested", "running"].includes(q.state.data.status.state)
        ? 5_000
        : false,
  });

  const applyUpdate = useMutation({
    mutationFn: () => api("/api/settings/updates", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["updates"] }),
  });

  // Asked for once before it happens. Going back is recoverable — running it
  // again rolls forward — but it does take the business offline for a minute,
  // which is not something to do on a mis-click.
  const [confirmRollback, setConfirmRollback] = useState(false);
  const rollback = useMutation({
    mutationFn: () => api("/api/settings/rollback", { method: "POST" }),
    onSuccess: () => {
      setConfirmRollback(false);
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const [keyInput, setKeyInput] = useState("");
  const enterKey = useMutation({
    mutationFn: () =>
      api("/api/settings/license", {
        method: "POST",
        body: JSON.stringify({ key: keyInput }),
      }),
    onSuccess: () => {
      setKeyInput("");
      qc.invalidateQueries({ queryKey: ["license"] });
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const sync = useMutation({
    mutationFn: () => api("/api/settings/sync", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["license"] });
      qc.invalidateQueries({ queryKey: ["updates"] });
    },
  });

  const rename = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      setName(null);
      setDetails(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  const data = settings.data;
  if (!data) return null;

  const saved = {
    address: data.business.address,
    taxId: data.business.taxId,
    taxIdLabel: data.business.taxIdLabel,
    paymentInstructions: data.business.paymentInstructions,
  };
  const form = details ?? saved;
  const patch = (change: Record<string, string>) =>
    setDetails({ ...form, ...change });
  const dirty =
    (name !== null && name !== data.business.name) ||
    (Object.keys(saved) as (keyof typeof saved)[]).some(
      (k) => form[k] !== saved[k],
    );

  const { stripe, paypal } = data.payments;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <p className="mb-3 font-medium">Your business</p>
        <div className="space-y-3">
          <Field
            label="Name"
            hint="Appears on invoices, the customer portal and your storefront."
          >
            <Input
              value={name ?? data.business.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          {/*
            An invoice with only a name is not a valid document in the UK or
            the EU, and a business paid by transfer whose invoices omit its
            account details answers "where do I send this?" on every one.
          */}
          <Field
            label="Address"
            hint="Required on invoices in the UK and EU. Appears at the foot of every one."
          >
            <textarea
              rows={3}
              value={form.address}
              onChange={(e) => patch({ address: e.target.value })}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-raised)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Tax number label" hint="e.g. VAT number, ABN, EIN.">
              <Input
                value={form.taxIdLabel}
                placeholder="VAT number"
                onChange={(e) => patch({ taxIdLabel: e.target.value })}
              />
            </Field>
            <Field
              label="Tax number"
              hint="Leave blank if you are not registered."
            >
              <Input
                value={form.taxId}
                onChange={(e) => patch({ taxId: e.target.value })}
              />
            </Field>
          </div>

          <Field
            label="How to pay"
            hint="Bank details or instructions, shown on the customer's page."
          >
            <textarea
              rows={3}
              value={form.paymentInstructions}
              onChange={(e) => patch({ paymentInstructions: e.target.value })}
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{
                background: "var(--surface-raised)",
                borderColor: "var(--border)",
                color: "var(--text)",
              }}
            />
          </Field>

          <Button
            onClick={() =>
              rename.mutate({ name: name ?? data.business.name, ...form })
            }
            disabled={
              rename.isPending || !(name ?? data.business.name) || !dirty
            }
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {rename.error ? <ErrorNote error={rename.error} /> : null}
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Email</p>
          <State ok={data.email.configured} yes="working" no="not set up" />
        </div>
        <p className="mt-1 text-sm" style={muted}>
          {data.email.configured
            ? `Sent from ${data.email.from ?? "the configured address"}.`
            : "Invoices, receipts and reminders will not be delivered until an email provider is configured on the server."}
        </p>
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Stripe</p>
          <State
            ok={stripe.configured && stripe.webhookConfigured}
            yes={stripe.testMode ? "test mode" : "taking payments"}
            no={stripe.configured ? "webhook missing" : "not set up"}
          />
        </div>

        {stripe.configured && !stripe.webhookConfigured ? (
          // The failure that costs real money, so it is stated plainly.
          <p className="mt-1 text-sm" style={{ color: "var(--color-danger)" }}>
            Cards can be charged but nothing will be recorded. Add the webhook
            below and its signing secret to the server before taking payments.
          </p>
        ) : null}

        {stripe.testMode ? (
          <p className="mt-1 text-sm" style={muted}>
            Test keys are in use — no real card will be charged.
          </p>
        ) : null}

        <Copyable
          label="Webhook for invoices"
          value={stripe.invoiceWebhookUrl}
        />
        <Copyable label="Webhook for the shop" value={stripe.shopWebhookUrl} />
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">PayPal</p>
          <State
            ok={paypal.configured && paypal.webhookConfigured}
            yes={paypal.environment === "live" ? "taking payments" : "sandbox"}
            no={paypal.configured ? "webhook id missing" : "not set up"}
          />
        </div>
        {paypal.configured && !paypal.webhookConfigured ? (
          <p className="mt-1 text-sm" style={{ color: "var(--color-danger)" }}>
            Without the webhook id, PayPal events cannot be verified and every
            one will be refused.
          </p>
        ) : null}
        <Copyable label="Webhook for the shop" value={paypal.shopWebhookUrl} />
      </Card>

      {licence.data?.failedBundles?.length ? (
        // Paid features vanishing without explanation is the worst way to
        // find out about this, so it goes at the top and stays red.
        <Card>
          <p className="font-medium" style={{ color: "var(--color-danger)" }}>
            A paid module did not start
          </p>
          {licence.data.failedBundles.map((f) => (
            <p key={f.name} className="mt-1 text-sm">
              <strong>{f.name}</strong> — {f.reason}
            </p>
          ))}
          <p className="mt-2 text-sm" style={muted}>
            Everything that module provides is unavailable until this is fixed.
            Reinstalling it with <code>sentrello update</code> is the usual
            remedy; if it persists, the release is at fault rather than your
            instance.
          </p>
        </Card>
      ) : null}

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Licence</p>
          {licence.data ? (
            <State
              ok={licence.data.valid}
              yes={licence.data.tier === "pro" ? "Pro" : "Free"}
              no="not verified"
            />
          ) : null}
        </div>
        {licence.data ? (
          <>
            {!licence.data.valid ? (
              // The answer to "why did my features disappear?"
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--color-warning)" }}
              >
                Running as Free
                {licence.data.reason ? `: ${licence.data.reason}` : "."} Paid
                features stay dark until a valid licence is in place. Your data
                is untouched and returns when it is.
              </p>
            ) : null}

            {/*
              Upgrading from Free. Without this, buying Pro means SSH into your
              own server and editing a dotfile at the moment you hand over
              money — so the purchase ends in a support ticket rather than a
              working instance.
            */}
            {!licence.data.valid || licence.data.tier !== "pro" ? (
              <div
                className="mt-3 border-t pt-3"
                style={{ borderColor: "var(--border)" }}
              >
                <Field
                  label="Licence key"
                  hint="From the email you were sent after buying. Paid features appear once it is checked."
                >
                  <Input
                    value={keyInput}
                    placeholder="SENT-XXXX-XXXX-XXXX-XXXX"
                    onChange={(e) => setKeyInput(e.target.value)}
                  />
                </Field>
                <div className="mt-2">
                  <Button
                    onClick={() => enterKey.mutate()}
                    disabled={enterKey.isPending || keyInput.trim().length < 24}
                  >
                    {enterKey.isPending ? "Checking…" : "Activate"}
                  </Button>
                </div>
                {enterKey.error ? <ErrorNote error={enterKey.error} /> : null}
              </div>
            ) : (
              // Bought a module on the website a minute ago? This is what makes
              // it appear now rather than whenever the daily refresh runs.
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => sync.mutate()}
                  disabled={sync.isPending}
                  className="text-sm underline"
                  style={muted}
                >
                  {sync.isPending
                    ? "Checking your subscription…"
                    : "Check my subscription for changes"}
                </button>
                {sync.error ? <ErrorNote error={sync.error} /> : null}
              </div>
            )}

            {licence.data.modules.length > 0 ? (
              <p className="mt-1 text-sm" style={muted}>
                Modules: {licence.data.modules.join(", ")}
              </p>
            ) : null}

            {licence.data.tokenExpiresAt ? (
              <p className="mt-1 text-sm" style={muted}>
                Licence token renews automatically; this one is valid until{" "}
                {new Date(licence.data.tokenExpiresAt).toLocaleString()}. A
                renewal that cannot reach the licence server is not urgent —
                there is a grace period before anything changes.
              </p>
            ) : null}

            {licence.data.graceUntil ? (
              <p
                className="mt-1 text-sm"
                style={{ color: "var(--color-warning)" }}
              >
                Billing needs attention. Paid features keep working until{" "}
                {new Date(licence.data.graceUntil).toLocaleDateString()}.
              </p>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Updates</p>
          <State
            ok={!updates.data?.updateAvailable}
            yes="up to date"
            no="update available"
          />
        </div>

        <p className="mt-1 text-sm" style={muted}>
          Running version {updates.data?.current ?? "…"}.
        </p>

        {/*
          An update replaces the running container, so the app cannot do it
          itself. Where the host has no agent to do it, saying so beats a
          button that appears to work and silently does nothing.
        */}
        {updates.data?.updateAvailable ? (
          updates.data.canApply ? (
            <>
              <p className="mt-1 text-sm">
                Version {updates.data.latest} is available. Updating takes about
                a minute, during which the app is unavailable. Your data is not
                touched.
              </p>
              <div className="mt-2">
                <Button
                  onClick={() => applyUpdate.mutate()}
                  disabled={
                    applyUpdate.isPending ||
                    ["requested", "running"].includes(updates.data.status.state)
                  }
                >
                  {["requested", "running"].includes(updates.data.status.state)
                    ? "Updating…"
                    : `Update to ${updates.data.latest}`}
                </Button>
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm">
              Version {updates.data.latest} is available. This instance cannot
              update itself, so run <code>sentrello update</code> on the server.
            </p>
          )
        ) : null}

        {/*
          Kept quieter than the update above it, and only shown when there is
          somewhere to go back to. It is the thing you want at 2am after a bad
          update, not something to invite on an ordinary Tuesday.
        */}
        {updates.data?.rollbackTo && updates.data.canApply ? (
          <div
            className="mt-3 border-t pt-3"
            style={{ borderColor: "var(--border)" }}
          >
            {confirmRollback ? (
              <>
                <p className="text-sm">
                  Go back to {updates.data.rollbackTo}? The app restarts and is
                  unavailable for a minute or two.
                </p>
                <p className="mt-1 text-sm" style={muted}>
                  {/* The question everyone actually has, answered before it is asked. */}
                  Your data is not changed — nothing entered since the update is
                  lost. If you need the database put back as well, that is a
                  separate step on the server.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    onClick={() => rollback.mutate()}
                    disabled={rollback.isPending}
                  >
                    {rollback.isPending
                      ? "Going back…"
                      : `Go back to ${updates.data.rollbackTo}`}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setConfirmRollback(false)}
                    className="text-sm underline"
                    style={muted}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm" style={muted}>
                Something wrong after updating?{" "}
                <button
                  type="button"
                  onClick={() => setConfirmRollback(true)}
                  className="underline"
                  disabled={["requested", "running"].includes(
                    updates.data.status.state,
                  )}
                >
                  Go back to {updates.data.rollbackTo}
                </button>
              </p>
            )}
            {rollback.error ? <ErrorNote error={rollback.error} /> : null}
          </div>
        ) : null}

        {updates.data && updates.data.status.state !== "idle" ? (
          <p
            className="mt-2 text-sm"
            style={
              updates.data.status.state === "failed"
                ? { color: "var(--color-danger)" }
                : muted
            }
          >
            {updates.data.status.message ?? updates.data.status.state}
          </p>
        ) : null}

        {applyUpdate.error ? <ErrorNote error={applyUpdate.error} /> : null}

        {updates.data && updates.data.latest === null ? (
          <p className="mt-1 text-sm" style={muted}>
            Update checks need a licence, so this instance will not check on its
            own. Updates are published on GitHub.
          </p>
        ) : null}
      </Card>

      <Card>
        <p className="font-medium">This instance</p>
        <p className="mt-1 text-sm" style={muted}>
          Links in emails are built from {data.instance.baseUrl}.
        </p>
        {licence.data?.instanceId ? (
          <p className="mt-1 text-xs" style={muted}>
            Instance {licence.data.instanceId}
          </p>
        ) : null}
        {!data.instance.baseUrlMatchesRequest ? (
          // The reason a customer receives a link pointing at localhost.
          <p className="mt-1 text-sm" style={{ color: "var(--color-warning)" }}>
            That does not match the address you are using right now. Links sent
            to customers may not work until the server's configured address is
            corrected.
          </p>
        ) : null}
      </Card>
    </div>
  );
}
