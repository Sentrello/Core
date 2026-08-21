export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * What the server said, when it said anything.
     *
     * The server often knows why — "this customer has 3 invoices" — and that
     * sentence is more use to someone than any status code. Kept separate so
     * a screen can choose to show it rather than being handed a raw message
     * meant for a log.
     */
    readonly serverMessage?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      res.status,
      `${init?.method ?? "GET"} ${path} failed`,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  return (await res.json()) as T;
}

export type Meta = {
  /** The release this instance runs, used to key module scripts by version. */
  version?: string;
  /** `moduleId` is which module registered the entry, and owns its screens. */
  nav: {
    id: string;
    label: string;
    order?: number;
    moduleId: string;
    group?: string;
    /** Set on a module's own pages: the id of the entry they sit under. */
    parent?: string;
    icon?: string;
  }[];
  loaded: string[];
  /**
   * Every optional module this licence allows, and whether it is set up.
   *
   * One that is not set up appears nowhere else: it is deliberately absent
   * from the sidebar until somebody turns it on.
   */
  modules: { id: string; label: string; enabled: boolean }[];
  /** module ids that shipped screens this instance may serve */
  ui: string[];
  /**
   * Whether this person is part of the business running this instance.
   *
   * False for a billing-only account — someone who bought Sentrello and has a
   * login purely to manage what they pay for. They see none of the
   * application.
   */
  belongsHere?: boolean;
  /** Where such a person belongs instead, on the instance that sells Sentrello. */
  accountPath?: string | null;
};

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  kind: string;
};

/** Money is integer cents on the wire, as it is everywhere else. */
export type Invoice = {
  id: string;
  number: string;
  contactId: string | null;
  status: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  dueDate: string | null;
  issuedAt: string | null;
};

export type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
};

export type Expense = {
  id: string;
  vendor: string | null;
  amountCents: number;
  spentAt: string;
  accountId: string | null;
};

export type ProfitAndLoss = {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
};

export type FormDefinition = {
  id: string;
  key: string;
  name: string;
  kind: string;
  /** Which form a submission came from; every form collects a name. */
  tag?: string | null;
  fields?: { name: string; label: string; type: string; required?: boolean }[];
  style?: { accent?: string; radius?: string } | null;
  submissionCount?: number;
};
