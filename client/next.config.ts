import type { NextConfig } from 'next';
import fs from 'fs';
import path from 'path';

// Load root .env so client can access shared env vars (e.g. GOOGLE_CLIENT_ID)
const rootEnvPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].replace(/\s+#.*$/, '').trim();
    }
  }
}

// API_URL for proxy: must NOT use process.env.PORT (Next.js sets it to its own port)
const backendPort = (process.env.BACKEND_PORT || '12054').trim();
const apiUrl = (process.env.API_URL || `http://localhost:${backendPort}`).trim();
// Public API URL baked into the client bundle. Falls back to apiUrl for local dev.
const publicApiUrl = (process.env.NEXT_PUBLIC_API_URL || apiUrl).trim();

const nextConfig: NextConfig = {
  // Allow large multipart uploads through Next.js dev proxy (default 10MB → 100MB).
  // Must stay aligned with server multer limit in server/src/routes/uploads.ts.
  // Next 16 已改名為 proxyClientMaxBodySize。
  experimental: {
    // @ts-ignore - Next 15.5 runtime 接受此 key (跨 next minor patch 型別差異不一)
    middlewareClientMaxBodySize: '100mb',
  },
  env: {
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    NEXT_PUBLIC_API_URL: publicApiUrl,
    NEXT_PUBLIC_DEPLOY_MODE: process.env.DEPLOY_MODE || 'pro-panjit',
    NEXT_PUBLIC_LINE_LIFF_ID: process.env.LINE_LIFF_ID || '',
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
      {
        // LINE Bot 等外部 webhook 需要從 agents.theaken.com 反代到 Express。
        source: '/webhook/:path*',
        destination: `${apiUrl}/webhook/:path*`,
      },
    ];
  },
};

export default nextConfig;
