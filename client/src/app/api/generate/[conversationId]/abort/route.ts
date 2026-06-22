import { NextRequest, NextResponse } from 'next/server';

// 127.0.0.1 (not "localhost"): Node 18+ resolves localhost to ::1 (IPv6) first,
// but the Express backend listens on IPv4 → fetch to localhost fails. Pin IPv4.
const BACKEND = 'http://127.0.0.1:12054';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;

  const backendRes = await fetch(
    `${BACKEND}/api/generate/${conversationId}/abort`,
    {
      method: 'POST',
      headers: {
        Authorization: req.headers.get('Authorization') || '',
      },
    },
  );

  const data = await backendRes.json();
  return NextResponse.json(data, { status: backendRes.status });
}
