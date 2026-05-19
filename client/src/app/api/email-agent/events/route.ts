import { NextRequest } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const BACKEND = 'http://localhost:12054';

export async function GET(req: NextRequest) {
  const backendRes = await fetch(`${BACKEND}/api/email-agent/events`, {
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
