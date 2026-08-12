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

interface SettingsResponse {
  business: { name: string; slug: string };
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

export function Settings() {
  const qc = useQueryClient();
  const [name, setName] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("/api/settings"),
  });

  const rename = useMutation({
    mutationFn: (value: string) =>
      api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ name: value }),
      }),
    onSuccess: () => {
      setName(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  const data = settings.data;
  if (!data) return null;

  const { stripe, paypal } = data.payments;

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <p className="mb-3 font-medium">Your business</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field
            label="Name"
            hint="Appears on invoices, the customer portal and your storefront."
          >
            <Input
              value={name ?? data.business.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => name && rename.mutate(name)}
              disabled={
                rename.isPending || !name || name === data.business.name
              }
            >
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
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

      <Card>
        <p className="font-medium">This instance</p>
        <p className="mt-1 text-sm" style={muted}>
          Links in emails are built from {data.instance.baseUrl}.
        </p>
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
