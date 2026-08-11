export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} failed`);
  }
  return (await res.json()) as T;
}

export type Meta = {
  /** `moduleId` is which module registered the entry, and owns its screens. */
  nav: { id: string; label: string; order?: number; moduleId: string }[];
  loaded: string[];
  /** module ids that shipped screens this instance may serve */
  ui: string[];
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
  submissionCount?: number;
};
