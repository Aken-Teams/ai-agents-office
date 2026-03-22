import { NextRequest, NextResponse } from 'next/server';

const BACKEND = 'http://localhost:12054';

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
