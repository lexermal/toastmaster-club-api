import type { StoredCookie } from './http.js';
import { startRemoteView, type RemoteView, type VerificationServerOptions } from './verification.js';

export interface HumanVerification {
  /** Page where a person can see the browser and solve the check. */
  url: string;
  /** After this the attempt is abandoned and the client stops trying (see resetClearance). */
  expiresAt: Date;
}

export interface ClearanceOptions {
  /**
   * Attach to an already running Chromium (`--remote-debugging-port`), e.g. "http://localhost:9333".
   * The browser stays open afterwards.
   */
  cdpUrl?: string;
  /**
   * Cloudflare's managed challenge rejects headless Chromium, so the default is a visible window
   * (needs a display; on servers run under `xvfb-run`).
   */
  headless?: boolean;
  /** How long to let the check pass on its own before asking a human. Default 30 s. */
  autoTimeoutMs?: number;
  /**
   * Called with a link when Cloudflare wants a human (the "Verify you are human" checkbox).
   * Forward it wherever you like (chat, email, ...). Without it, that situation throws right away.
   */
  onHumanVerification?: (verification: HumanVerification) => void | Promise<void>;
  /** How long the link stays valid and the browser waits for the human. Default 15 min. */
  humanTimeoutMs?: number;
  /** Where the temporary verification page listens and how it is reachable from outside. */
  verificationServer?: VerificationServerOptions;
}

export interface Clearance {
  userAgent: string;
  cookies: StoredCookie[];
}

export class HumanVerificationError extends Error {
  constructor(
    message: string,
    /** "required": no onHumanVerification handler; "timeout": nobody solved it in time. */
    readonly reason: 'required' | 'timeout',
  ) {
    super(message);
    this.name = 'HumanVerificationError';
  }
}

/**
 * easy-Speak sits behind a Cloudflare managed challenge that plain HTTP can't pass.
 * A real browser solves it (usually by itself); the resulting `cf_clearance` cookie plus the exact
 * same User-Agent then work for plain `fetch` calls until the cookie expires.
 * This makes exactly one attempt with one browser — it never retries, because repeated fresh
 * browsers are what make Cloudflare escalate to the human check in the first place.
 */
export async function obtainClearance(host: string, opts: ClearanceOptions = {}): Promise<Clearance> {
  let pw: typeof import('playwright');
  try {
    pw = await import('playwright');
  } catch {
    throw new Error(
      'Cloudflare clearance needed but "playwright" is not installed. Run `npm i playwright && npx playwright install chromium`.',
    );
  }
  const browser = opts.cdpUrl
    ? await pw.chromium.connectOverCDP(opts.cdpUrl)
    : await pw.chromium.launch({
        headless: opts.headless ?? false,
        args: ['--disable-blink-features=AutomationControlled'],
      });
  let view: RemoteView | undefined;
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    try {
      await page.goto(`https://${host}/index.php`, { timeout: 60_000 }).catch(() => {});
      const passed = async () => {
        const cookies = await context.cookies(`https://${host}`);
        const title = await page.title().catch(() => 'Just a moment');
        if (!cookies.some((c) => c.name === 'cf_clearance') || title.includes('Just a moment')) return undefined;
        return {
          userAgent: await page.evaluate(() => navigator.userAgent),
          cookies: cookies
            .filter((c) => c.name.startsWith('cf_') || c.name.startsWith('__cf'))
            .map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
        };
      };
      const waitFor = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const result = await passed();
          if (result) return result;
          await page.waitForTimeout(1000);
        }
        return undefined;
      };

      const auto = await waitFor(opts.autoTimeoutMs ?? 30_000);
      if (auto) return auto;
      if (!opts.onHumanVerification) {
        throw new HumanVerificationError(
          'Cloudflare wants human verification. Pass clearance.onHumanVerification to get a link for solving it.',
          'required',
        );
      }

      const humanMs = opts.humanTimeoutMs ?? 15 * 60_000;
      view = await startRemoteView(page, opts.verificationServer);
      await opts.onHumanVerification({ url: view.url, expiresAt: new Date(Date.now() + humanMs) });
      const solved = await waitFor(humanMs);
      if (solved) return solved;
      throw new HumanVerificationError('Nobody solved the Cloudflare check in time.', 'timeout');
    } finally {
      await view?.close();
      await page.close().catch(() => {});
    }
  } finally {
    // For CDP connections this only disconnects; the user's browser keeps running.
    await browser.close().catch(() => {});
  }
}
