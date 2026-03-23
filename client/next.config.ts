import type { NextConfig } from 'next';
import fs from 'fs';
import path from 'path';

// Load root .env so client can access shared env vars (e.g. GOOGLE_CLIENT_ID)
const rootEnvPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(rootEnvPath)) {
  for (const line of fs.readFileSync(rootEnvPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

// API_URL for proxy: must NOT use process.env.PORT (Next.js sets it to its own port)
const backendPort = (process.env.BACKEND_PORT || '12054').trim();
const apiUrl = (process.env.API_URL || `http://localhost:${backendPort}`).trim();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    NEXT_PUBLIC_API_URL: apiUrl,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
