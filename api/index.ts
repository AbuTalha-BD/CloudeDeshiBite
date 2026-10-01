import type { Request, Response } from 'express';
import { createExpressApp } from '../server.js';

let cachedApp: any = null;

// Vercel serverless function URL normalizer
function normalizeUrl(req: Request) {
  try {
    const rawUrl = req.url || '/';

    // 1. Check original forwarded headers from Vercel edge/gateway
    const originalUrl = (req.headers['x-forwarded-uri'] as string) || (req.headers['x-original-url'] as string) || '';
    if (originalUrl && originalUrl.startsWith('/api') && originalUrl !== '/api' && originalUrl !== '/api/') {
      req.url = originalUrl;
      return;
    }

    const matchedPath = (req.headers['x-matched-path'] as string) || '';
    if (matchedPath && matchedPath.startsWith('/api') && matchedPath !== '/api' && matchedPath !== '/api/') {
      req.url = matchedPath;
      return;
    }

    // 2. Check query string parameters (from vercel.json rewrite /api?path=... or catch-all /api/[...path])
    const u = new URL(rawUrl, 'http://localhost');
    const p = u.searchParams.get('path') ?? u.searchParams.get('...path') ?? u.searchParams.get('0');
    if (p) {
      u.searchParams.delete('path');
      u.searchParams.delete('...path');
      u.searchParams.delete('0');
      const cleanPath = Array.isArray(p) ? p.join('/') : String(p).replace(/^\//, '');
      const search = u.search || '';
      req.url = `/api/${cleanPath}${search}`;
      return;
    }

    // 3. Fallback: if req.url is already a complete /api/... path, keep it
    if (rawUrl.startsWith('/api')) {
      req.url = rawUrl;
    }
  } catch {
    // keep original url
  }
}

export default async function handler(req: Request, res: Response) {
  try {
    if (!cachedApp) {
      cachedApp = await createExpressApp();
    }
    normalizeUrl(req);

    return new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      cachedApp(req, res, (err: any) => {
        if (err && !res.headersSent) {
          res.statusCode = typeof err.status === 'number' ? err.status : 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message || 'Internal server error', success: false }));
        } else if (!res.headersSent) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `Route not found: ${req.method} ${req.url}`, success: false }));
        }
        resolve();
      });
    });
  } catch (fatalErr: any) {
    console.error('[Fatal Serverless Exception]:', fatalErr);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: fatalErr?.message || 'Server initialization error', success: false }));
    }
  }
}
