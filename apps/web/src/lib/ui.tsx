/**
 * The small set of primitives every screen is built from.
 *
 * Hand-written rather than pulled from a component library: the whole product
 * is tables, forms and money, and each of these is a few lines. Every one reads
 * the design tokens in index.css, so light and dark come free and the app can
 * be rethemed from one file.
 */
import type { ReactNode } from "react";

export const border = { borderColor: "var(--border)" };
export const muted = { color: "var(--text-muted)" };
const raised = { background: "var(--surface-raised)", ...border };

/** Cents to "$1,234.56". Money never arrives as a float and never becomes one. */
export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100,
  );
}

/** Basis points to "8.75%". */
export function formatRate(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d);
}

export function Button({
  children,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles = {
    primary: {
      background: "var(--color-brand-500)",
      color: "var(--color-neutral-50)",
    },
    secondary: { background: "transparent", ...border, color: "var(--text)" },
    danger: { background: "var(--color-danger)", color: "white" },
  }[variant];

  return (
    <button
      type="button"
      {...rest}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
        variant === "secondary" ? "border" : ""
      } ${rest.className ?? ""}`}
      style={{ ...styles, ...rest.style }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    // The control is always the child, so the association is implicit and
    // valid HTML. The rule cannot see through the component boundary to
    // confirm that, which is why it is disabled here and nowhere else.
    // biome-ignore lint/a11y/noLabelWithoutControl: the input is passed as children
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs" style={muted}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
      style={{ ...raised, ...props.style }}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded border px-2 py-1.5 text-sm ${props.className ?? ""}`}
      style={{ ...raised, ...props.style }}
    />
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded border p-4 ${className}`} style={raised}>
      {children}
    </div>
  );
}

export function Table({
  headers,
  children,
}: {
  headers: (string | { label: string; money?: boolean })[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left" style={border}>
            {headers.map((h) => {
              const label = typeof h === "string" ? h : h.label;
              const money = typeof h !== "string" && h.money;
              return (
                <th
                  key={label}
                  className={`py-2 font-medium ${money ? "money" : ""}`}
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <tr className="border-b" style={border}>
      {children}
    </tr>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded border p-8 text-center" style={border}>
      <p className="font-medium">{title}</p>
      {children ? (
        <p className="mt-1 text-sm" style={muted}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

export function Loading() {
  return (
    <p className="text-sm" style={muted}>
      Loading…
    </p>
  );
}

/**
 * One place where a failed request becomes something a person can act on.
 *
 * 403 is worth distinguishing: the difference between "you cannot do this" and
 * "something broke" is the difference between asking an administrator and
 * filing a bug.
 */
export function ErrorNote({ error }: { error: unknown }) {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: number }).status
      : 0;
  // The server's own sentence beats anything guessed from a status code —
  // except for 401 and 403, where the useful advice is about the person
  // rather than the request.
  const fromServer =
    error && typeof error === "object" && "serverMessage" in error
      ? (error as { serverMessage?: string }).serverMessage
      : undefined;
  const message =
    status === 403
      ? "Your role does not allow this."
      : status === 401
        ? "Your session has expired. Sign in again."
        : (fromServer ?? "Something went wrong. Try again.");
  return (
    <p className="text-sm" style={{ color: "var(--color-danger)" }}>
      {message}
    </p>
  );
}

/** Invoice and quote states, coloured the way people read them. */
export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    paid: "var(--color-success)",
    open: "var(--color-info)",
    partial: "var(--color-warning)",
    overdue: "var(--color-danger)",
    draft: "var(--text-muted)",
    void: "var(--text-muted)",
  };
  return (
    <span
      className="rounded px-1.5 py-0.5 text-xs font-medium"
      style={{ color: tone[status] ?? "var(--text-muted)" }}
    >
      {status}
    </span>
  );
}
