import type { Request, Response } from 'express';
import { createExpressApp } from '../server.js';

let cachedApp: any = null;

// Vercel may hand us "/api" or "/api/[...path]" with the real path in the query string.
// Only in those cases do we rebuild the URL; otherwise req.url is already the real path.
function normalizeUrl(req: Request) {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const looksRewritten = u.pathname === '/api' || u.pathname === '/api/' || u.pathname.includes('[...path]');
    const p = u.searchParams.get('...path') ?? u.searchParams.get('path');
    if (looksRewritten && p) {
      u.searchParams.delete('...path');
      u.searchParams.delete('path');
      req.url = `/api/${p.replace(/^\//, '')}${u.search}`;
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
