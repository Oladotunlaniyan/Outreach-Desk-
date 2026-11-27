import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from './app.ts';

const app = createApiApp({ ensureDbOnRequest: true });

function normalizeVercelApiUrl(rawUrl: string | undefined): string {
  const url = new URL(rawUrl || '/api', 'http://localhost');
  const pathParam = url.searchParams.get('__path');

  if (pathParam !== null) {
    url.searchParams.delete('__path');
    const isRewrittenToIndex =
      url.pathname === '/api/index' ||
      url.pathname === '/api/index.js' ||
      url.pathname === '/api';

    if (isRewrittenToIndex) {
      const normalizedSubpath = pathParam.replace(/^\/+/, '');
      url.pathname = normalizedSubpath ? `/api/${normalizedSubpath}` : '/api';
    }
  }

  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  req.url = normalizeVercelApiUrl(req.url);
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
