import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CDPSession, Page } from 'playwright';

export interface VerificationServerOptions {
  /** Port of the temporary verification page. Default 8732. */
  port?: number;
  /** Interface to bind. Default "0.0.0.0" (reachable from a Kubernetes Service). */
  host?: string;
  /** Public base URL the port is exposed under (Ingress / Service), e.g. "https://tm-verify.example.com". */
  publicUrl?: string;
}

export interface RemoteView {
  url: string;
  close(): Promise<void>;
}

/**
 * Serves a live view of `page` and forwards the viewer's mouse and keyboard to it, so a person
 * can solve Cloudflare's human check from anywhere. Uses the browser's own screencast (CDP), so
 * no VNC tooling is needed. The URL carries a random token and the server lives only until close().
 */
export async function startRemoteView(page: Page, opts: VerificationServerOptions = {}): Promise<RemoteView> {
  const token = randomBytes(16).toString('hex');
  const base = `/${token}`;
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const clients = new Set<ServerResponse>();
  let frame = '';
  let size = { width: 1280, height: 720 };

  cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    frame = data;
    size = { width: metadata.deviceWidth, height: metadata.deviceHeight };
    for (const res of clients) res.write(`data: ${data}\n\n`);
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // Chromium only streams frames for a tab it is drawing; a background tab would stay blank.
  await page.bringToFront();
  // The screencast only emits on change, so seed the view with a still of the current state.
  frame = (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })).data;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70 });

  async function input(body: { type: string; x?: number; y?: number; key?: string }) {
    // The viewer sends coordinates as 0..1 fractions of the image; map them to CSS pixels.
    const x = (body.x ?? 0) * size.width;
    const y = (body.y ?? 0) * size.height;
    if (body.type === 'move') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (body.type === 'click') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    if (body.type === 'key' && body.key) {
      if (body.key.length === 1) await cdp.send('Input.insertText', { text: body.key });
      else await page.keyboard.press(body.key);
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === base || req.url === `${base}/`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(VIEWER_HTML(base));
    }
    if (req.url === `${base}/events`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.add(res);
      if (frame) res.write(`data: ${frame}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === `${base}/input` && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      await input(JSON.parse(raw || '{}')).catch(() => {});
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });

  const port = opts.port ?? 8732;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host ?? '0.0.0.0', resolve);
  });

  return {
    url: `${(opts.publicUrl ?? `http://localhost:${port}`).replace(/\/$/, '')}${base}/`,
    async close() {
      for (const res of clients) {
        res.write('event: done\ndata: ok\n\n');
        res.end();
      }
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const VIEWER_HTML = (base: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verification</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f5f5; --fg: #222; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px system-ui, sans-serif; }
  img { display: block; max-width: 100%; border: 1px solid #888; cursor: pointer; touch-action: manipulation; }
  #status { margin: 0 0 12px; }
</style></head><body>
<p id="status">Click the Cloudflare checkbox below as you would on the real site. Keys you type are sent too.</p>
<img id="screen" alt="Remote browser">
<script>
  const img = document.getElementById('screen');
  // Inputs go out strictly in order; parallel requests could reorder or drop fast keystrokes.
  let queue = Promise.resolve();
  const send = (body) => { queue = queue.then(() => fetch('${base}/input', { method: 'POST', body: JSON.stringify(body) })).catch(() => {}); };
  const pos = (e) => { const r = img.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  let last = 0;
  img.addEventListener('mousemove', (e) => { const now = Date.now(); if (now - last > 50) { last = now; send({ type: 'move', ...pos(e) }); } });
  img.addEventListener('click', (e) => send({ type: 'click', ...pos(e) }));
  document.addEventListener('keydown', (e) => { send({ type: 'key', key: e.key }); e.preventDefault(); });
  const events = new EventSource('${base}/events');
  events.onmessage = (e) => { img.src = 'data:image/jpeg;base64,' + e.data; };
  events.addEventListener('done', () => { document.getElementById('status').textContent = 'Done — you can close this page.'; img.remove(); events.close(); });
</script></body></html>`;
