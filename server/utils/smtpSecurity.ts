import dns from 'node:dns/promises';
import net from 'node:net';

export type SmtpSecurityMode = 'implicit_tls' | 'starttls';

export interface ResolvedSmtpAddress {
  address: string;
  family: 4 | 6;
}

const DISALLOWED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.aws.internal',
  'instance-data',
]);

const DISALLOWED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.arpa',
  '.home.arpa',
];

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0;
}

function isIpv4InCidr(ipInt: number, networkIp: string, prefixLen: number): boolean {
  const netInt = parseIpv4ToInt(networkIp);
  if (netInt === null) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

export function isDisallowedIpv4(ip: string): boolean {
  const ipInt = parseIpv4ToInt(ip);
  if (ipInt === null) return true;

  return (
    isIpv4InCidr(ipInt, '0.0.0.0', 8) || // "this network"
    isIpv4InCidr(ipInt, '10.0.0.0', 8) || // RFC 1918 private
    isIpv4InCidr(ipInt, '100.64.0.0', 10) || // CGNAT RFC 6598
    isIpv4InCidr(ipInt, '127.0.0.0', 8) || // loopback
    isIpv4InCidr(ipInt, '169.254.0.0', 16) || // link-local & cloud metadata 169.254.169.254
    isIpv4InCidr(ipInt, '172.16.0.0', 12) || // RFC 1918 private
    isIpv4InCidr(ipInt, '192.0.0.0', 24) || // IETF protocol assignments
    isIpv4InCidr(ipInt, '192.0.2.0', 24) || // TEST-NET-1
    isIpv4InCidr(ipInt, '192.88.99.0', 24) || // 6to4 relay anycast
    isIpv4InCidr(ipInt, '192.168.0.0', 16) || // RFC 1918 private
    isIpv4InCidr(ipInt, '198.18.0.0', 15) || // benchmarking
    isIpv4InCidr(ipInt, '198.51.100.0', 24) || // TEST-NET-2
    isIpv4InCidr(ipInt, '203.0.113.0', 24) || // TEST-NET-3
    isIpv4InCidr(ipInt, '224.0.0.0', 4) || // multicast
    isIpv4InCidr(ipInt, '240.0.0.0', 4) // reserved & broadcast
  );
}

function expandIpv6ToWords(ip: string): number[] | null {
  const withoutZone = ip.split('%')[0].toLowerCase();
  if (!net.isIPv6(withoutZone)) return null;

  // Handle IPv4-embedded suffix (e.g. ::ffff:127.0.0.1)
  let normalized = withoutZone;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const ipv4Part = normalized.slice(lastColon + 1);
    const v4Int = parseIpv4ToInt(ipv4Part);
    if (v4Int === null) return null;
    const high = ((v4Int >>> 16) & 0xffff).toString(16);
    const low = (v4Int & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];

  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  const zerosCount = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  const fullParts = [...left, ...Array(zerosCount).fill('0'), ...right];
  if (fullParts.length !== 8) return null;

  const words: number[] = [];
  for (const part of fullParts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  return words;
}

export function isDisallowedIpAddress(rawIp: string): boolean {
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(trimmed);
  if (ipVersion === 4) {
    return isDisallowedIpv4(trimmed);
  }
  if (ipVersion !== 6) {
    return true;
  }

  const words = expandIpv6ToWords(trimmed);
  if (!words) return true;

  const isZero = words.every((w) => w === 0);
  if (isZero) return true; // :: unspecified

  const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
  if (isLoopback) return true; // ::1

  // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::0:0/96
  const isV4Mapped =
    words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0);
  if (isV4Mapped) {
    const v4 = `${(words[6] >>> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >>> 8) & 0xff}.${words[7] & 0xff}`;
    return isDisallowedIpv4(v4);
  }

  // Unique local addresses fc00::/7 (fc00..fdff)
  if ((words[0] & 0xfe00) === 0xfc00) return true;

  // Link-local fe80::/10
  if ((words[0] & 0xffc0) === 0xfe80) return true;

  // Multicast ff00::/8
  if ((words[0] & 0xff00) === 0xff00) return true;

  // Documentation 2001:db8::/32
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

  return false;
}

const HOSTNAME_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateSmtpHostFormat(
  rawHost: string
): { ok: true; host: string } | { ok: false; error: string } {
  const host = rawHost.trim().toLowerCase().replace(/\.+$/, '');

  if (!host) {
    return { ok: false, error: 'SMTP hostname is required.' };
  }
  if (host.length > 253) {
    return { ok: false, error: 'SMTP hostname exceeds 253 characters.' };
  }
  if (
    host.includes('://') ||
    host.includes('/') ||
    host.includes('\\') ||
    host.includes('@') ||
    host.includes('?') ||
    host.includes('#') ||
    /\s/.test(host)
  ) {
    return {
      ok: false,
      error: 'SMTP hostname must be a plain domain name without protocol, credentials, or path.',
    };
  }

  const unbracketed = host.replace(/^\[|\]$/g, '');
  if (net.isIP(unbracketed) !== 0) {
    if (isDisallowedIpAddress(unbracketed)) {
      return {
        ok: false,
        error:
          'Local, private, loopback, link-local, and cloud metadata IP addresses are not allowed for SMTP hosts.',
      };
    }
    return { ok: true, host: unbracketed };
  }

  // Reject single-label hostnames and port suffixes embedded in hostname
  if (host.includes(':')) {
    return {
      ok: false,
      error: 'Enter the SMTP port in the dedicated Port field, not inside the hostname.',
    };
  }

  if (
    DISALLOWED_HOSTNAMES.has(host) ||
    DISALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return {
      ok: false,
      error: 'Localhost, internal, and reserved hostnames are not allowed for SMTP servers.',
    };
  }

  const labels = host.split('.');
  if (labels.length < 2) {
    return {
      ok: false,
      error: 'SMTP hostname must be a valid fully qualified domain name (e.g. smtp.provider.com).',
    };
  }

  if (labels.some((label) => !HOSTNAME_LABEL_REGEX.test(label))) {
    return { ok: false, error: 'SMTP hostname contains invalid characters or labels.' };
  }

  // Reject purely numeric TLD (e.g. obfuscated decimal/hex IP tricks)
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) {
    return { ok: false, error: 'SMTP hostname must use a valid domain suffix.' };
  }

  return { ok: true, host };
}

export function validateAndResolveSmtpSecurity(
  portInput: number,
  requestedMode?: SmtpSecurityMode
):
  | {
      ok: true;
      port: number;
      securityMode: SmtpSecurityMode;
      secure: boolean;
      requireTLS: boolean;
    }
  | { ok: false; error: string } {
  if (!Number.isInteger(portInput) || portInput < 1 || portInput > 65535) {
    return { ok: false, error: 'SMTP port must be an integer between 1 and 65535.' };
  }

  // Reject clearly non-SMTP privileged ports (allow 25, 465, 587, or >= 1024)
  if (portInput < 1024 && portInput !== 25 && portInput !== 465 && portInput !== 587) {
    return {
      ok: false,
      error:
        'Use standard SMTP ports (465, 587, 2525, 25) or a custom provider port >= 1024.',
    };
  }

  if (portInput === 465) {
    if (requestedMode === 'starttls') {
      return {
        ok: false,
        error: 'Port 465 uses implicit TLS and cannot be configured as STARTTLS.',
      };
    }
    return {
      ok: true,
      port: 465,
      securityMode: 'implicit_tls',
      secure: true,
      requireTLS: false,
    };
  }

  if (portInput === 587) {
    if (requestedMode === 'implicit_tls') {
      return {
        ok: false,
        error: 'Port 587 requires STARTTLS rather than implicit TLS.',
      };
    }
    return {
      ok: true,
      port: 587,
      securityMode: 'starttls',
      secure: false,
      requireTLS: true,
    };
  }

  const securityMode: SmtpSecurityMode = requestedMode ?? 'starttls';
  return {
    ok: true,
    port: portInput,
    securityMode,
    secure: securityMode === 'implicit_tls',
    requireTLS: securityMode === 'starttls',
  };
}

export async function resolveAndValidateSmtpHost(
  host: string,
  lookupFn: (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>> = (h, opts) =>
    dns.lookup(h, opts)
): Promise<
  | { ok: true; addresses: ResolvedSmtpAddress[] }
  | { ok: false; error: string; code: 'INVALID_HOST' | 'DNS_FAILED' | 'SSRF_BLOCKED' }
> {
  const hostCheck = validateSmtpHostFormat(host);
  if (!hostCheck.ok) {
    return { ok: false, error: hostCheck.error, code: 'INVALID_HOST' };
  }

  const validatedHost = hostCheck.host;
  const literalIpFamily = net.isIP(validatedHost);
  if (literalIpFamily === 4 || literalIpFamily === 6) {
    if (isDisallowedIpAddress(validatedHost)) {
      return {
        ok: false,
        code: 'SSRF_BLOCKED',
        error: 'Target IP address is blocked by outbound network safety policy.',
      };
    }
    return {
      ok: true,
      addresses: [{ address: validatedHost, family: literalIpFamily }],
    };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await lookupFn(validatedHost, { all: true, verbatim: true });
  } catch {
    return {
      ok: false,
      code: 'DNS_FAILED',
      error: `Could not resolve SMTP hostname "${validatedHost}". Verify the server address.`,
    };
  }

  if (!Array.isArray(resolved) || resolved.length === 0) {
    return {
      ok: false,
      code: 'DNS_FAILED',
      error: `No DNS records were found for SMTP hostname "${validatedHost}".`,
    };
  }

  const safeAddresses: ResolvedSmtpAddress[] = [];
  for (const record of resolved) {
    if (isDisallowedIpAddress(record.address)) {
      return {
        ok: false,
        code: 'SSRF_BLOCKED',
        error: `SMTP hostname "${validatedHost}" resolved to a restricted or private network address.`,
      };
    }
    if (record.family === 4 || record.family === 6) {
      safeAddresses.push({ address: record.address, family: record.family });
    }
  }

  if (safeAddresses.length === 0) {
    return {
      ok: false,
      code: 'DNS_FAILED',
      error: `No usable IPv4 or IPv6 addresses resolved for "${validatedHost}".`,
    };
  }

  return { ok: true, addresses: safeAddresses };
}
