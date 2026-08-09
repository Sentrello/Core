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
  nav: { id: string; label: string; order?: number }[];
  loaded: string[];
};

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  kind: string;
};
