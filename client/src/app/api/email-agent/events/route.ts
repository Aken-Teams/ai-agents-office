import { NextRequest } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';
// This proxies an SSE stream that never ends by design — it stays open for as
// long as the mail widget is on screen. Next's fetch cache tries to tee the
// response body so it can store it, which for an endless body means holding a
// reader open forever; undici eventually kills it with UND_ERR_BODY_TIMEOUT and
// the request 500s after ~10 minutes ("Failed to set fetch cache … terminated").
// The widget reconnects, so nothing breaks, but the log fills with stack traces
// that hide real errors. `dynamic` alone does not cover it: the caching decision
// for the OUTGOING fetch is a separate switch.
export const fetchCache = 'force-no-store';
export const revalidate = 0;

// 127.0.0.1 (not "localhost"): Node 18+ resolves localhost to ::1 (IPv6) first,
// but the Express backend listens on IPv4 → fetch to localhost fails. Pin IPv4.
const BACKEND = 'http://127.0.0.1:12054';

export async function GET(req: NextRequest) {
  const backendRes = await fetch(`${BACKEND}/api/email-agent/events`, {
    method: 'GET',
    headers: {
      Authorization: req.headers.get('Authorization') || '',
    },
    cache: 'no-store',
    // Hand the browser's disconnect through to the backend. Without it, closing
    // the tab or switching conversations abandons this upstream connection with
    // nobody reading it: undici then waits out its 300s body timeout and throws
    // UND_ERR_BODY_TIMEOUT, which is why the failures showed up as "10 minutes"
    // rather than any round number, and why the backend only noticed the client
    // had gone long after it actually left.
    signal: req.signal,
  });

  if (!backendRes.ok || !backendRes.body) {
    const text = await backendRes.text();
    return new Response(text, {
      status: backendRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(backendRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
