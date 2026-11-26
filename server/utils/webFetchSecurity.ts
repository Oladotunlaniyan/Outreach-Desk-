import dns from 'node:dns/promises';
import net from 'node:net';
import { isDisallowedIpAddress } from './smtpSecurity.ts';

const DISALLOWED_HTTP_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.aws.internal',
  'instance-data',
]);

const DISALLOWED_HTTP_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.arpa',
  '.home.arpa',
];

export interface SafeHttpFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  lookupFn?: (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>>;
}

export interface SafeHttpFetchResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  redirectLocation?: string;
}

export function validatePublicHttpUrl(
  rawUrl: string
): { ok: true; url: URL } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL syntax.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are permitted.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Embedded URL credentials are not permitted.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { ok: false, error: 'URL hostname is missing.' };
  }

  if (net.isIP(host) !== 0) {
    if (isDisallowedIpAddress(host)) {
      return { ok: false, error: 'Private or loopback IP addresses are blocked.' };
    }
    return { ok: true, url: parsed };
  }

  if (
    DISALLOWED_HTTP_HOSTNAMES.has(host) ||
    DISALLOWED_HTTP_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return { ok: false, error: 'Local or internal hostnames are blocked.' };
  }

  const labels = host.split('.');
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) {
    return { ok: false, error: 'Hostname must be a public domain.' };
  }

  return { ok: true, url: parsed };
}

export async function assertPublicHttpTarget(
  rawUrl: string,
  lookupFn: SafeHttpFetchOptions['lookupFn'] = (h, opts) => dns.lookup(h, opts)
): Promise<{ ok: true; url: URL } | { ok: false; error: string; code: string }> {
  const checked = validatePublicHttpUrl(rawUrl);
  if (!checked.ok) {
    return { ok: false, error: checked.error, code: 'INVALID_PUBLIC_URL' };
  }

  const host = checked.url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    return { ok: true, url: checked.url };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: `Could not resolve hostname "${host}".`, code: 'DNS_FAILED' };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, error: `No DNS records found for "${host}".`, code: 'DNS_FAILED' };
  }

  for (const record of records) {
    if (isDisallowedIpAddress(record.address)) {
      return {
        ok: false,
        error: `Hostname "${host}" resolved to a restricted network address.`,
        code: 'SSRF_BLOCKED',
      };
    }
  }

  return { ok: true, url: checked.url };
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (remaining <= 0) break;

      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel().catch(() => {});
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}

export async function fetchSafePublicUrl(
  rawUrl: string,
  options: SafeHttpFetchOptions = {}
): Promise<SafeHttpFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 350_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const fetchImpl = options.fetchFn ?? fetch;

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const targetCheck = await assertPublicHttpTarget(currentUrl, options.lookupFn);
    if (!targetCheck.ok) {
      throw new Error(targetCheck.error);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();

    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error('Request aborted');
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetchImpl(targetCheck.url.toString(), {
        method: options.method ?? 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; OutreachDeskResearchBot/1.0; +https://outreach-desk.local)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.8',
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          return {
            ok: false,
            status: res.status,
            finalUrl: targetCheck.url.toString(),
            contentType: res.headers.get('content-type') || '',
            body: '',
          };
        }
        if (hop >= maxRedirects) {
          return {
            ok: false,
            status: res.status,
            finalUrl: targetCheck.url.toString(),
            contentType: res.headers.get('content-type') || '',
            body: '',
            redirectLocation: loc,
          };
        }
        currentUrl = new URL(loc, targetCheck.url).toString();
        continue;
      }

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (options.method === 'HEAD') {
        return {
          ok: res.ok,
          status: res.status,
          finalUrl: targetCheck.url.toString(),
          contentType,
          body: '',
        };
      }

      const isTextLike =
        !contentType ||
        contentType.includes('text/html') ||
        contentType.includes('text/plain') ||
        contentType.includes('application/xhtml+xml') ||
        contentType.includes('application/json') ||
        contentType.includes('application/xml');

      if (!isTextLike) {
        return {
          ok: false,
          status: res.status,
          finalUrl: targetCheck.url.toString(),
          contentType,
          body: '',
        };
      }

      const body = res.ok ? await readResponseWithLimit(res, maxBytes) : '';
      return {
        ok: res.ok,
        status: res.status,
        finalUrl: targetCheck.url.toString(),
        contentType,
        body,
      };
    } finally {
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  throw new Error('Exceeded maximum HTTP redirects.');
}
