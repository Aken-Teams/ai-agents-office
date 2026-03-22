import { NextRequest } from 'next/server';

const BACKEND = 'http://localhost:12054';

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const target = `${BACKEND}/api/files/${path.join('/')}`;

  const headers: Record<string, string> = {};
  const auth = req.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;
  const ct = req.headers.get('Content-Type');
  if (ct) headers['Content-Type'] = ct;

  const backendRes = await fetch(target, {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined,
  });

  const resHeaders = new Headers();
  for (const key of ['content-type', 'content-disposition', 'content-length']) {
    const val = backendRes.headers.get(key);
    if (val) resHeaders.set(key, val);
  }

  return new Response(backendRes.body, {
    status: backendRes.status,
    headers: resHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
