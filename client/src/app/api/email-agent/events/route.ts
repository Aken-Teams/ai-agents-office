import { NextRequest } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

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
