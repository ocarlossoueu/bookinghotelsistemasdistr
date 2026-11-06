import { lamport } from './lamport';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

let onUnauthorized: (code: string) => void = () => undefined;
export function setUnauthorizedHandler(fn: (code: string) => void) {
  onUnauthorized = fn;
}

export interface CallMeta {
  instanceId: string | null;
  correlationId: string | null;
  status: number;
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T & { _meta: CallMeta }> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-lamport': String(lamport.send()),
      'x-correlation-id': crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (typeof data?.lamport === 'number') lamport.receive(data.lamport);
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && path !== '/session') onUnauthorized(e.code);
    throw new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? 'Falha na requisição', e.details);
  }
  return {
    ...data,
    _meta: { instanceId: res.headers.get('x-instance-id'), correlationId: res.headers.get('x-correlation-id'), status: res.status },
  };
}

export const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function fmtDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

export function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function nights(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}
