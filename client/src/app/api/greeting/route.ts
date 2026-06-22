import { NextRequest } from 'next/server';

// Streaming proxy for the AI greeting SSE. Mirrors /api/generate/[conversationId]
// — the edge runtime + returning the upstream ReadableStream body streams the
// greeting deltas live, instead of the dev rewrite proxy buffering them (which
// left the greeting popup stuck on "thinking…").

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// 127.0.0.1 (not "localhost"): Node 18+ resolves localhost to ::1 (IPv6) first,
// but the Express backend listens on IPv4 → fetch to localhost fails. Pin IPv4.
const BACKEND = 'http://127.0.0.1:12054';

export async function GET(req: NextRequest) {
  const qs = req.nextUrl.search || '';
  const backendRes = await fetch(`${BACKEND}/api/greeting${qs}`, {
    method: 'GET',
    headers: {
      Authorization: req.headers.get('Authorization') || '',
    },
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
