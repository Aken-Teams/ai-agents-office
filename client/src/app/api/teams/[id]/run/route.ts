import { NextRequest } from 'next/server';

// Streaming proxy for the team-collaboration SSE run. Mirrors
// /api/generate/[conversationId] — the edge runtime + returning the upstream
// ReadableStream body streams without the buffering the dev rewrite proxy adds.

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const BACKEND = 'http://localhost:12054';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.text();

  const backendRes = await fetch(`${BACKEND}/api/teams/${id}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: req.headers.get('Authorization') || '',
    },
    body,
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
