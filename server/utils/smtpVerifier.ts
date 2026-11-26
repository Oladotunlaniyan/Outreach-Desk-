import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import {
  resolveAndValidateSmtpHost,
  validateAndResolveSmtpSecurity,
  type ResolvedSmtpAddress,
  type SmtpSecurityMode,
} from './smtpSecurity.ts';
import { logEvent } from './logger.ts';

export interface SmtpVerificationInput {
  host: string;
  port: number;
  securityMode?: SmtpSecurityMode;
  username: string;
  password: string;
}

export interface SmtpVerificationResult {
  ok: boolean;
  message: string;
  errorCode?:
    | 'INVALID_CONFIG'
    | 'DNS_FAILED'
    | 'SSRF_BLOCKED'
    | 'TIMEOUT'
    | 'CONNECTION_REFUSED'
    | 'TLS_FAILED'
    | 'AUTH_FAILED'
    | 'SMTP_ERROR';
}

export interface SmtpVerifierDeps {
  createTransport?: (options: SMTPTransport.Options) => {
    verify: () => Promise<true | boolean>;
    close: () => void;
  };
  lookupHost?: (
    hostname: string,
    options: { all: true; verbatim: true }
  ) => Promise<Array<{ address: string; family: number }>>;
  tlsOptions?: SMTPTransport.Options['tls'];
}

export function sanitizeSmtpError(err: unknown): {
  message: string;
  errorCode: NonNullable<SmtpVerificationResult['errorCode']>;
} {
  const errObj = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    command?: unknown;
    message?: unknown;
  };

  const code = typeof errObj.code === 'string' ? errObj.code.toUpperCase() : '';
  const responseCode =
    typeof errObj.responseCode === 'number' ? errObj.responseCode : undefined;
  const rawMessage = typeof errObj.message === 'string' ? errObj.message : '';
  const lower = rawMessage.toLowerCase();

  if (
    code === 'EAUTH' ||
    responseCode === 535 ||
    responseCode === 534 ||
    responseCode === 530 ||
    lower.includes('invalid login') ||
    lower.includes('authentication failed') ||
    lower.includes('username and password not accepted')
  ) {
    return {
      errorCode: 'AUTH_FAILED',
      message:
        'SMTP authentication failed. Verify the username and password or app-specific password.',
    };
  }

  if (
    code === 'ESOCKET' &&
    (lower.includes('certificate') ||
      lower.includes('tls') ||
      lower.includes('ssl') ||
      lower.includes('wrong version number') ||
      lower.includes('altnames'))
  ) {
    return {
      errorCode: 'TLS_FAILED',
      message:
        'TLS handshake or certificate verification failed. Confirm the port matches implicit TLS (465) or STARTTLS (587/2525).',
    };
  }

  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    lower.includes('starttls') ||
    lower.includes('tls') ||
    lower.includes('ssl') ||
    lower.includes('certificate')
  ) {
    return {
      errorCode: 'TLS_FAILED',
      message:
        'TLS verification failed. Ensure the SMTP server presents a valid certificate and supports the configured TLS mode.',
    };
  }

  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    lower.includes('timeout') ||
    lower.includes('greeting never received')
  ) {
    return {
      errorCode: 'TIMEOUT',
      message:
        'Timed out connecting to the SMTP server. Verify the hostname, port, and firewall rules.',
    };
  }

  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET'
  ) {
    return {
      errorCode: 'CONNECTION_REFUSED',
      message:
        'Connection refused or unreachable at the configured SMTP host and port.',
    };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EDNS') {
    return {
      errorCode: 'DNS_FAILED',
      message: 'Could not resolve the configured SMTP hostname.',
    };
  }

  return {
    errorCode: 'SMTP_ERROR',
    message:
      'SMTP verification failed. Check the hostname, port, TLS setting, and credentials.',
  };
}

function buildValidatedDnsLookup(addresses: ResolvedSmtpAddress[]) {
  return (
    _hostname: string,
    optionsOrCb: unknown,
    maybeCb?: unknown
  ): void => {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
      err: Error | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number
    ) => void;
    const opts =
      typeof optionsOrCb === 'object' && optionsOrCb !== null
        ? (optionsOrCb as { all?: boolean })
        : {};

    if (opts.all) {
      cb(
        null,
        addresses.map((item) => ({ address: item.address, family: item.family }))
      );
      return;
    }
    const primary = addresses[0];
    cb(null, primary.address, primary.family);
  };
}

export async function verifyMailboxSmtpConnection(
  input: SmtpVerificationInput,
  deps: SmtpVerifierDeps = {}
): Promise<SmtpVerificationResult> {
  const securityCheck = validateAndResolveSmtpSecurity(input.port, input.securityMode);
  if (!securityCheck.ok) {
    return {
      ok: false,
      errorCode: 'INVALID_CONFIG',
      message: securityCheck.error,
    };
  }

  const dnsResult = await resolveAndValidateSmtpHost(input.host, deps.lookupHost);
  if (!dnsResult.ok) {
    return {
      ok: false,
      errorCode:
        dnsResult.code === 'INVALID_HOST'
          ? 'INVALID_CONFIG'
          : dnsResult.code,
      message: dnsResult.error,
    };
  }

  const transportFactory =
    deps.createTransport ?? ((opts: SMTPTransport.Options) => nodemailer.createTransport(opts));

  const transportOptions: SMTPTransport.Options & {
    lookup?: ReturnType<typeof buildValidatedDnsLookup>;
  } = {
    host: input.host.trim().toLowerCase(),
    port: securityCheck.port,
    secure: securityCheck.secure,
    requireTLS: securityCheck.requireTLS,
    ignoreTLS: false,
    auth: {
      user: input.username,
      pass: input.password,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: deps.tlsOptions ?? {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    lookup: buildValidatedDnsLookup(dnsResult.addresses),
  };

  const transporter = transportFactory(transportOptions);

  try {
    await transporter.verify();
    logEvent('info', 'smtp.verify_succeeded', {
      host: input.host.trim().toLowerCase(),
      port: securityCheck.port,
      securityMode: securityCheck.securityMode,
    });
    return {
      ok: true,
      message:
        'SMTP connection, TLS negotiation, and authentication verified without sending an email.',
    };
  } catch (err) {
    const sanitized = sanitizeSmtpError(err);
    logEvent('warn', 'smtp.verify_failed', {
      host: input.host.trim().toLowerCase(),
      port: securityCheck.port,
      errorCode: sanitized.errorCode,
    });
    return {
      ok: false,
      errorCode: sanitized.errorCode,
      message: sanitized.message,
    };
  } finally {
    try {
      transporter.close();
    } catch {
      // Ignore close cleanup errors
    }
  }
}
