const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
  'api-key',
]);

const SENSITIVE_QUERY_PARAMS = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'apikey',
  'api_key',
  'key',
  'secret',
  'password',
  'session',
  'sig',
  'signature',
  'code',
];

export const REDACTED = '[REDACTED]';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const param of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.includes(param.toLowerCase())) {
        u.searchParams.set(param, REDACTED);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}
