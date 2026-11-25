import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredCookie {
  name: string;
  value: string;
  /** Leading dot = domain cookie, otherwise host-only. */
  domain: string;
}

export interface SessionState {
  userAgent: string;
  cookies: StoredCookie[];
}

/**
 * Minimal single-site cookie jar. Cookies are keyed by domain + name because
 * easy-Speak sends `cf_clearance=deleted` without a Domain attribute (host-only),
 * which must NOT wipe Cloudflare's `.tmclub.eu` domain cookie — a browser keeps it too.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(initial: StoredCookie[] = []) {
    for (const c of initial) this.set(c);
  }

  set(c: StoredCookie) {
    this.cookies.set(`${c.domain}|${c.name}`, c);
  }

  has(name: string) {
    return [...this.cookies.values()].some((c) => c.name === name);
  }

  header() {
    return [...this.cookies.values()].map((c) => `${c.name}=${c.value}`).join('; ');
  }

  list() {
    return [...this.cookies.values()];
  }

  applySetCookie(setCookies: string[], host: string) {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let domain = host;
      let expired = value === 'deleted';
      for (const a of attrs) {
        const [k, v = ''] = a.split('=');
        const key = k.toLowerCase();
        if (key === 'domain' && v) domain = '.' + v.replace(/^\./, '');
        if (key === 'max-age' && Number(v) <= 0) expired = true;
        if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
      }
      if (expired) this.cookies.delete(`${domain}|${name}`);
      else this.set({ name, value, domain });
    }
  }
}

export async function loadSession(file: string): Promise<SessionState | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SessionState;
  } catch {
    return undefined;
  }
}

export async function saveSession(file: string, state: SessionState) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function isCloudflareChallenge(status: number, html: string) {
  return (status === 403 || status === 503) && /Just a moment|challenge-platform/.test(html);
}
