import http from 'node:http';
import https from 'node:https';

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** Milliseconds the probe took. */
  elapsedMs: number;
}

/**
 * Lightweight HTTP GET reachability probe. Any HTTP response — including
 * 404/500 — counts as "reachable": the server is up even if the app is not.
 */
export function probeUrl(url: string, timeoutMs = 3000): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Omit<ProbeResult, 'elapsedMs'>) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, elapsedMs: Date.now() - started });
    };
    let req: http.ClientRequest;
    try {
      const lib = url.startsWith('https:') ? https : http;
      req = lib.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'agentview-probe' } }, (res) => {
        res.resume();
        done({ ok: true, status: res.statusCode ?? null, error: null });
      });
    } catch (err) {
      done({ ok: false, status: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      done({ ok: false, status: null, error: err.message });
    });
  });
}

export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(u.hostname);
  } catch {
    return false;
  }
}
