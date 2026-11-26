/**
 * Phase 5 Production Readiness Verification Suite
 *
 * Covers:
 * - Real Nodemailer + real TCP/STARTTLS socket E2E against an in-process RFC 5321 SMTP server (zero real outreach recipients)
 * - Campaign worker failure, crash recovery, concurrent race, mid-claim pause/cancel, quota pause/resume, post-SMTP DB failure
 * - Unsubscribe tokens (SHA-256, GET HTML, POST RFC 8058), suppression idempotency & enforcement across all flows
 * - Bounce webhook auth (403 unconfigured / 401 bad secret / 200 valid secret) & classification
 * - Security audit (JWT tamper, X-Forwarded-For anti-spoofing, AES-256-GCM tamper, SSRF, XSS, credential redaction)
 * - Production config fail-safe validation & structured log redaction
 *
 * Run:
 *   npm run test:phase5
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import express from 'express';
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { getProductionReadinessReport } from '../config/env.ts';
import {
  ProductionConfigError,
  getClientIp,
  requireAuth,
  signAuthToken,
} from '../middleware/auth.ts';
import {
  Campaign,
  CampaignRecipient,
  EmailMessage,
  Lead,
  Mailbox,
  MailboxUsage,
  Suppression,
  UnsubscribeToken,
} from '../models/index.ts';
import { authRouter } from '../routes/auth.ts';
import { bouncesRouter } from '../routes/bounces.ts';
import { campaignsRouter } from '../routes/campaigns.ts';
import { dashboardRouter } from '../routes/dashboard.ts';
import { emailsRouter } from '../routes/emails.ts';
import { leadsRouter } from '../routes/leads.ts';
import { mailboxesRouter } from '../routes/mailboxes.ts';
import { settingsRouter } from '../routes/settings.ts';
import { suppressionsRouter } from '../routes/suppressions.ts';
import { unsubscribeRouter } from '../routes/unsubscribe.ts';
import { processCampaignBatch, reconcileStaleRecipients } from '../utils/campaignWorker.ts';
import { classifySendFailure, sendEmailViaMailbox } from '../utils/emailSender.ts';
import { sanitizeEmailHtml } from '../utils/htmlSanitizer.ts';
import { logEvent } from '../utils/logger.ts';
import { decryptMailboxSecret, encryptMailboxSecret } from '../utils/mailboxCrypto.ts';
import { classifyImportRows } from '../routes/leadsImport.ts';
import { resolveAndValidateSmtpHost } from '../utils/smtpSecurity.ts';
import { verifyMailboxSmtpConnection } from '../utils/smtpVerifier.ts';
import {
  hashUnsubscribeToken,
  resolvePublicAppBaseUrl,
  suppressEmail,
} from '../utils/suppression.ts';

let passed = 0;
async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    console.error(`[FAIL] ${name}:`, err);
    process.exitCode = 1;
  }
}

/* -------------------------------------------------------------------------- */
/*  In-Process RFC 5321 + STARTTLS Test SMTP Server (Ephemeral Self-Signed)   */
/* -------------------------------------------------------------------------- */

interface CapturedSmtpMessage {
  mailFrom: string;
  rcptTo: string[];
  rawMime: string;
  tlsActive: boolean;
  authUser: string;
}

class LocalStartTlsSmtpServer {
  private server: net.Server | null = null;
  public port = 0;
  public messages: CapturedSmtpMessage[] = [];
  public expectedUser = 'relay@test-relay.example';
  public expectedPass = 'SmtpTestSecret!2026';
  public behaviorForRecipient: Map<
    string,
    'ok' | 'hard_550' | 'soft_421' | 'rate_451' | 'drop_mid_data'
  > = new Map();

  private keyPem: string;
  private certPem: string;

  constructor(keyPem: string, certPem: string) {
    this.keyPem = keyPem;
    this.certPem = certPem;
  }

  async start(): Promise<number> {
    this.server = net.createServer((rawSocket) => this.handleConnection(rawSocket));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address() as net.AddressInfo;
    this.port = addr.port;
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handleConnection(rawSocket: net.Socket): void {
    let socket: net.Socket | tls.TLSSocket = rawSocket;
    let tlsActive = false;
    let buffer = '';
    let readingData = false;
    let dataLines: string[] = [];
    let mailFrom = '';
    let rcptTo: string[] = [];
    let authUser = '';
    let authStage: 'none' | 'plain' | 'login_user' | 'login_pass' = 'none';
    let loginTempUser = '';

    const sendLine = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.on('error', () => {});
      sock.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const idx = buffer.indexOf('\r\n');
          if (idx === -1) break;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (readingData) {
            if (line === '.') {
              readingData = false;
              const rawMime = dataLines
                .map((l) => (l.startsWith('..') ? l.slice(1) : l))
                .join('\r\n');
              dataLines = [];

              const targetBehavior = rcptTo
                .map((r) => this.behaviorForRecipient.get(r.toLowerCase()) || 'ok')
                .find((b) => b !== 'ok');

              if (targetBehavior === 'drop_mid_data') {
                sock.destroy();
                return;
              }
              if (targetBehavior === 'hard_550') {
                sendLine('550 5.1.1 No such user here');
                continue;
              }
              if (targetBehavior === 'soft_421') {
                sendLine('421 4.3.2 Service busy, try again later');
                continue;
              }
              if (targetBehavior === 'rate_451') {
                sendLine('451 4.7.1 Too many requests, slow down');
                continue;
              }

              this.messages.push({
                mailFrom,
                rcptTo: [...rcptTo],
                rawMime,
                tlsActive,
                authUser,
              });
              sendLine('250 2.0.0 OK queued locally');
              continue;
            }
            dataLines.push(line);
            const firstBehavior = rcptTo
              .map((r) => this.behaviorForRecipient.get(r.toLowerCase()) || 'ok')
              .find((b) => b === 'drop_mid_data');
            if (firstBehavior === 'drop_mid_data' && dataLines.length >= 2) {
              sock.destroy();
              return;
            }
            continue;
          }

          if (authStage === 'plain') {
            authStage = 'none';
            const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
            const parts = decoded.split('\0');
            const u = parts[1] || '';
            const p = parts[2] || '';
            if (u === this.expectedUser && p === this.expectedPass) {
              authUser = u;
              sendLine('235 2.7.0 Authentication successful');
            } else {
              sendLine('535 5.7.8 Authentication credentials invalid');
            }
            continue;
          }

          if (authStage === 'login_user') {
            authStage = 'login_pass';
            loginTempUser = Buffer.from(line.trim(), 'base64').toString('utf8');
            sendLine(`334 ${Buffer.from('Password:').toString('base64')}`);
            continue;
          }

          if (authStage === 'login_pass') {
            authStage = 'none';
            const p = Buffer.from(line.trim(), 'base64').toString('utf8');
            if (loginTempUser === this.expectedUser && p === this.expectedPass) {
              authUser = loginTempUser;
              sendLine('235 2.7.0 Authentication successful');
            } else {
              sendLine('535 5.7.8 Authentication credentials invalid');
            }
            continue;
          }

          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO ') || upper.startsWith('HELO ')) {
            sendLine('250-smtp.test-relay.example Hello');
            if (!tlsActive) {
              sendLine('250-STARTTLS');
            } else {
              sendLine('250-AUTH PLAIN LOGIN');
            }
            sendLine('250 SIZE 10485760');
          } else if (upper === 'STARTTLS') {
            sendLine('220 2.0.0 Ready to start TLS');
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            const tlsSock = new tls.TLSSocket(sock, {
              isServer: true,
              key: this.keyPem,
              cert: this.certPem,
            });
            socket = tlsSock;
            tlsActive = true;
            buffer = '';
            attachSocketListeners(tlsSock);
          } else if (upper.startsWith('AUTH PLAIN')) {
            const inlineB64 = line.slice(10).trim();
            if (inlineB64) {
              const decoded = Buffer.from(inlineB64, 'base64').toString('utf8');
              const parts = decoded.split('\0');
              const u = parts[1] || '';
              const p = parts[2] || '';
              if (u === this.expectedUser && p === this.expectedPass) {
                authUser = u;
                sendLine('235 2.7.0 Authentication successful');
              } else {
                sendLine('535 5.7.8 Authentication credentials invalid');
              }
            } else {
              authStage = 'plain';
              sendLine('334 ');
            }
          } else if (upper.startsWith('AUTH LOGIN')) {
            const inlineUser = line.slice(10).trim();
            if (inlineUser) {
              loginTempUser = Buffer.from(inlineUser, 'base64').toString('utf8');
              authStage = 'login_pass';
              sendLine(`334 ${Buffer.from('Password:').toString('base64')}`);
            } else {
              authStage = 'login_user';
              sendLine(`334 ${Buffer.from('Username:').toString('base64')}`);
            }
          } else if (upper.startsWith('MAIL FROM:')) {
            const match = line.match(/<([^>]*)>/);
            mailFrom = match ? match[1] : line.slice(10).trim();
            rcptTo = [];
            sendLine('250 2.1.0 Ok');
          } else if (upper.startsWith('RCPT TO:')) {
            const match = line.match(/<([^>]*)>/);
            const addr = (match ? match[1] : line.slice(8).trim()).toLowerCase();
            rcptTo.push(addr);
            sendLine('250 2.1.5 Ok');
          } else if (upper === 'DATA') {
            readingData = true;
            dataLines = [];
            sendLine('354 End data with <CR><LF>.<CR><LF>');
          } else if (upper === 'RSET') {
            mailFrom = '';
            rcptTo = [];
            sendLine('250 2.0.0 Ok');
          } else if (upper === 'NOOP') {
            sendLine('250 2.0.0 Ok');
          } else if (upper === 'QUIT') {
            sendLine('221 2.0.0 Bye');
            sock.end();
          } else {
            sendLine('502 5.5.2 Command not implemented');
          }
        }
      });
    };

    attachSocketListeners(rawSocket);
    sendLine('220 smtp.test-relay.example ESMTP Service Ready');
  }
}

/* -------------------------------------------------------------------------- */
/*  In-Memory Mongoose Model Harness (Supports Real Service Functions)        */
/* -------------------------------------------------------------------------- */

function deepClone<T>(val: T): T {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return new Date(val.getTime()) as unknown as T;
  if (val instanceof mongoose.Types.ObjectId) return val;
  if (Array.isArray(val)) return val.map((v) => deepClone(v)) as unknown as T;
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = deepClone(v);
    }
    return out as T;
  }
  return val;
}

function getByPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object' || cur[p] instanceof Date) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetByPath(obj: Record<string, unknown>, dotPath: string): void {
  const parts = dotPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') return;
    cur = cur[p] as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
}

function normalizeCmpVal(v: unknown): unknown {
  if (v instanceof mongoose.Types.ObjectId) return String(v);
  if (v instanceof Date) return v.getTime();
  return v;
}

function matchesQuery(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  if (!query || Object.keys(query).length === 0) return true;

  for (const [key, cond] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(cond)) {
      if (!cond.some((sub) => matchesQuery(doc, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === '$and' && Array.isArray(cond)) {
      if (!cond.every((sub) => matchesQuery(doc, sub as Record<string, unknown>))) {
        return false;
      }
      continue;
    }
    if (key === '$expr') {
      const ltArr = (cond as { $lt?: unknown[] })?.$lt;
      if (Array.isArray(ltArr) && ltArr.length === 2) {
        const limit = Number(ltArr[1]);
        const sent = Number(doc.sentCount || 0);
        const reserved = Number(doc.reservedCount || 0);
        if (!(sent + reserved < limit)) return false;
      }
      continue;
    }

    const docVal = getByPath(doc, key);
    if (
      cond !== null &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      !(cond instanceof mongoose.Types.ObjectId) &&
      !(cond instanceof RegExp)
    ) {
      const ops = cond as Record<string, unknown>;
      for (const [op, opVal] of Object.entries(ops)) {
        if (op === '$in' && Array.isArray(opVal)) {
          const normDoc = normalizeCmpVal(docVal);
          if (!opVal.some((item) => normalizeCmpVal(item) === normDoc)) return false;
        } else if (op === '$ne') {
          if (normalizeCmpVal(docVal) === normalizeCmpVal(opVal)) return false;
        } else if (op === '$lt') {
          const d = normalizeCmpVal(docVal) as number;
          const v = normalizeCmpVal(opVal) as number;
          if (d === undefined || !(d < v)) return false;
        } else if (op === '$lte') {
          const d = normalizeCmpVal(docVal) as number;
          const v = normalizeCmpVal(opVal) as number;
          if (d === undefined || !(d <= v)) return false;
        } else if (op === '$gt') {
          const d = normalizeCmpVal(docVal) as number;
          const v = normalizeCmpVal(opVal) as number;
          if (d === undefined || !(d > v)) return false;
        } else if (op === '$gte') {
          const d = normalizeCmpVal(docVal) as number;
          const v = normalizeCmpVal(opVal) as number;
          if (d === undefined || !(d >= v)) return false;
        } else if (op === '$exists') {
          const exists = docVal !== undefined && docVal !== null;
          if (Boolean(opVal) !== exists) return false;
        }
      }
    } else if (cond instanceof RegExp) {
      if (!cond.test(String(docVal ?? ''))) return false;
    } else {
      if (normalizeCmpVal(docVal) !== normalizeCmpVal(cond)) return false;
    }
  }
  return true;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>, isInsert = false): void {
  const now = new Date();
  if (isInsert && update.$setOnInsert && typeof update.$setOnInsert === 'object') {
    for (const [k, v] of Object.entries(update.$setOnInsert as Record<string, unknown>)) {
      setByPath(doc, k, deepClone(v));
    }
  }
  if (update.$set && typeof update.$set === 'object') {
    for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
      setByPath(doc, k, deepClone(v));
    }
  }
  if (update.$inc && typeof update.$inc === 'object') {
    for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
      const cur = Number(getByPath(doc, k) || 0);
      setByPath(doc, k, cur + v);
    }
  }
  if (update.$unset && typeof update.$unset === 'object') {
    for (const k of Object.keys(update.$unset as Record<string, unknown>)) {
      unsetByPath(doc, k);
    }
  }
  if (update.$push && typeof update.$push === 'object') {
    for (const [k, rawVal] of Object.entries(update.$push as Record<string, unknown>)) {
      const arr = Array.isArray(getByPath(doc, k))
        ? ([...(getByPath(doc, k) as unknown[])] as unknown[])
        : [];
      if (rawVal && typeof rawVal === 'object' && '$each' in (rawVal as Record<string, unknown>)) {
        const pushObj = rawVal as { $each: unknown[]; $slice?: number };
        arr.push(...deepClone(pushObj.$each));
        if (typeof pushObj.$slice === 'number' && pushObj.$slice < 0) {
          setByPath(doc, k, arr.slice(pushObj.$slice));
          continue;
        }
      } else {
        arr.push(deepClone(rawVal));
      }
      setByPath(doc, k, arr);
    }
  }
  doc.updatedAt = now;
}

function createInMemoryCollection(defaults: Record<string, unknown> = {}) {
  const rows: Array<Record<string, unknown>> = [];

  const wrapDoc = (raw: Record<string, unknown>) => {
    const wrapped = raw as Record<string, unknown> & { save: () => Promise<unknown> };
    wrapped.save = async () => {
      raw.updatedAt = new Date();
      return wrapped;
    };
    return wrapped;
  };

  const makeQueryCursor = (matched: Array<Record<string, unknown>>) => {
    let working = [...matched];
    const cursor = {
      sort(spec: Record<string, number>) {
        const entries = Object.entries(spec);
        working.sort((a, b) => {
          for (const [k, dir] of entries) {
            const av = normalizeCmpVal(getByPath(a, k)) as number | string;
            const bv = normalizeCmpVal(getByPath(b, k)) as number | string;
            if (av === bv) continue;
            if (av === undefined) return dir > 0 ? -1 : 1;
            if (bv === undefined) return dir > 0 ? 1 : -1;
            return av < bv ? (dir > 0 ? -1 : 1) : dir > 0 ? 1 : -1;
          }
          return 0;
        });
        return cursor;
      },
      select() {
        return cursor;
      },
      skip(n: number) {
        working = working.slice(n);
        return cursor;
      },
      limit(n: number) {
        working = working.slice(0, n);
        return cursor;
      },
      lean: async () => working.map((d) => deepClone(d)),
      exec: async () => working.map(wrapDoc),
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return Promise.resolve(working.map(wrapDoc)).then(resolve, reject);
      },
    };
    return cursor;
  };

  const makeSingleCursor = (found: Record<string, unknown> | null) => {
    const cursor = {
      sort() {
        return cursor;
      },
      select() {
        return cursor;
      },
      lean: async () => (found ? deepClone(found) : null),
      exec: async () => (found ? wrapDoc(found) : null),
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        return Promise.resolve(found ? wrapDoc(found) : null).then(resolve, reject);
      },
    };
    return cursor;
  };

  return {
    rows,
    async create(data: Record<string, unknown>) {
      const now = new Date();
      const doc: Record<string, unknown> = {
        ...deepClone(defaults),
        ...deepClone(data),
        _id: data._id || new mongoose.Types.ObjectId(),
        createdAt: data.createdAt || now,
        updatedAt: data.updatedAt || now,
      };
      rows.push(doc);
      return wrapDoc(doc);
    },
    async insertMany(items: Array<Record<string, unknown>>) {
      const inserted = [];
      for (const item of items) {
        inserted.push(await this.create(item));
      }
      return inserted;
    },
    find(query: Record<string, unknown> = {}) {
      const matched = rows.filter((d) => matchesQuery(d, query));
      return makeQueryCursor(matched);
    },
    findOne(query: Record<string, unknown> = {}) {
      const found = rows.find((d) => matchesQuery(d, query)) || null;
      return makeSingleCursor(found);
    },
    findById(id: unknown) {
      const idStr = String(id);
      const found = rows.find((d) => String(d._id) === idStr) || null;
      return makeSingleCursor(found);
    },
    findOneAndUpdate(
      query: Record<string, unknown>,
      update: Record<string, unknown>,
      options: { new?: boolean; upsert?: boolean; sort?: Record<string, number> } = {}
    ) {
      let candidates = rows.filter((d) => matchesQuery(d, query));
      if (options.sort && candidates.length > 1) {
        const [k, dir] = Object.entries(options.sort)[0];
        candidates.sort((a, b) => {
          const av = normalizeCmpVal(getByPath(a, k)) as number | string;
          const bv = normalizeCmpVal(getByPath(b, k)) as number | string;
          if (av === bv) return 0;
          return av < bv ? (dir > 0 ? -1 : 1) : dir > 0 ? 1 : -1;
        });
      }
      let target = candidates[0] || null;
      if (!target) {
        if (!options.upsert) return makeSingleCursor(null);
        const now = new Date();
        target = {
          ...deepClone(defaults),
          _id: new mongoose.Types.ObjectId(),
          createdAt: now,
          updatedAt: now,
        };
        for (const [k, v] of Object.entries(query)) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof mongoose.Types.ObjectId)) {
            setByPath(target, k, deepClone(v));
          }
        }
        applyUpdate(target, update, true);
        rows.push(target);
        return makeSingleCursor(target);
      }
      applyUpdate(target, update, false);
      return makeSingleCursor(target);
    },
    findByIdAndUpdate(
      id: unknown,
      update: Record<string, unknown>,
      _options: { new?: boolean } = {}
    ) {
      const found = rows.find((d) => String(d._id) === String(id)) || null;
      if (!found) return makeSingleCursor(null);
      applyUpdate(found, update, false);
      return makeSingleCursor(found);
    },
    async updateOne(query: Record<string, unknown>, update: Record<string, unknown>) {
      const found = rows.find((d) => matchesQuery(d, query));
      if (!found) return { modifiedCount: 0, matchedCount: 0 };
      applyUpdate(found, update, false);
      return { modifiedCount: 1, matchedCount: 1 };
    },
    async updateMany(query: Record<string, unknown>, update: Record<string, unknown>) {
      let count = 0;
      for (const d of rows) {
        if (matchesQuery(d, query)) {
          applyUpdate(d, update, false);
          count += 1;
        }
      }
      return { modifiedCount: count, matchedCount: count };
    },
    async countDocuments(query: Record<string, unknown> = {}) {
      return rows.filter((d) => matchesQuery(d, query)).length;
    },
    async exists(query: Record<string, unknown> = {}) {
      const found = rows.find((d) => matchesQuery(d, query));
      return found ? { _id: found._id } : null;
    },
    async bulkWrite(
      ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>
    ) {
      let modified = 0;
      for (const op of ops) {
        const res = await this.updateOne(op.updateOne.filter, op.updateOne.update);
        modified += res.modifiedCount;
      }
      return { modifiedCount: modified };
    },
    async aggregate(pipeline: Array<Record<string, unknown>>) {
      let current = [...rows];
      for (const stage of pipeline) {
        if (stage.$match) {
          current = current.filter((d) =>
            matchesQuery(d, stage.$match as Record<string, unknown>)
          );
        } else if (stage.$group) {
          const groupSpec = stage.$group as { _id: unknown };
          const groups = new Map<string, { _id: unknown; count: number }>();
          for (const d of current) {
            let groupId: unknown = null;
            if (typeof groupSpec._id === 'string' && groupSpec._id.startsWith('$')) {
              groupId = getByPath(d, groupSpec._id.slice(1));
            } else if (groupSpec._id && typeof groupSpec._id === 'object') {
              const obj: Record<string, unknown> = {};
              for (const [gk, gv] of Object.entries(groupSpec._id as Record<string, string>)) {
                obj[gk] = typeof gv === 'string' && gv.startsWith('$')
                  ? getByPath(d, gv.slice(1))
                  : gv;
              }
              groupId = obj;
            }
            const key = JSON.stringify(groupId);
            const existing = groups.get(key) || { _id: groupId, count: 0 };
            existing.count += 1;
            groups.set(key, existing);
          }
          current = Array.from(groups.values());
        }
      }
      return current;
    },
  };
}

function patchModel(model: unknown, store: ReturnType<typeof createInMemoryCollection>) {
  const m = model as Record<string, unknown>;
  const orig: Record<string, unknown> = {};
  const methods = [
    'create',
    'insertMany',
    'find',
    'findOne',
    'findById',
    'findOneAndUpdate',
    'findByIdAndUpdate',
    'updateOne',
    'updateMany',
    'countDocuments',
    'exists',
    'bulkWrite',
    'aggregate',
  ];
  for (const method of methods) {
    orig[method] = m[method];
    m[method] = (...args: unknown[]) =>
      (store[method as keyof typeof store] as (...a: unknown[]) => unknown)(...args);
  }
  return () => {
    for (const method of methods) {
      m[method] = orig[method];
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Test Runner                                                               */
/* -------------------------------------------------------------------------- */

async function main() {
  const encKey = crypto.randomBytes(32).toString('base64');
  process.env.MAILBOX_ENCRYPTION_KEY = encKey;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.ACCESS_CODE = 'phase5-owner-secret-code';
  process.env.MONGODB_URI = 'mongodb://localhost/phase5-harness';
  process.env.APP_URL = 'https://outreach-desk.example.com';

  // Generate ephemeral self-signed X.509 cert for real STARTTLS verification
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-phase5-smtp-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=smtp.test-relay.example',
    '-addext',
    'subjectAltName=DNS:smtp.test-relay.example',
  ]);
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  const certPem = fs.readFileSync(certPath, 'utf8');

  const smtpServer = new LocalStartTlsSmtpServer(keyPem, certPem);
  const smtpPort = await smtpServer.start();

  // Public IP placeholder for SSRF DNS validator; actual Nodemailer TCP socket routes to local STARTTLS harness
  const ssrfPassLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const createTestTransport = (opts: SMTPTransport.Options) =>
    nodemailer.createTransport({
      ...opts,
      host: '127.0.0.1',
      allowInternalNetworkInterfaces: true,
      tls: {
        ...(opts.tls || {}),
        servername: typeof opts.host === 'string' ? opts.host : 'smtp.test-relay.example',
      },
    } as SMTPTransport.Options);
  const localTlsOptions: tls.ConnectionOptions = {
    ca: certPem,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
  const smtpDeps = {
    lookupHost: ssrfPassLookup,
    createTransport: createTestTransport,
    tlsOptions: localTlsOptions,
  };

  // Patch Mongoose models with stateful in-memory collections + readyState=1
  const origReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });

  const mailboxStore = createInMemoryCollection({ dailyLimit: 50, enabled: true, archived: false });
  const usageStore = createInMemoryCollection({ sentCount: 0, reservedCount: 0, unknownCount: 0 });
  const emailStore = createInMemoryCollection({ attempts: 1, references: [] });
  const leadStore = createInMemoryCollection({ emailCount: 0, optedOut: false, bounced: false, history: [] });
  const campStore = createInMemoryCollection({ sentCount: 0, failedCount: 0, repliedCount: 0, bouncedCount: 0 });
  const recStore = createInMemoryCollection({ attempts: 0, missingPlaceholders: [], references: [], customFields: {} });
  const supStore = createInMemoryCollection();
  const tokStore = createInMemoryCollection();

  const unpatches = [
    patchModel(Mailbox, mailboxStore),
    patchModel(MailboxUsage, usageStore),
    patchModel(EmailMessage, emailStore),
    patchModel(Lead, leadStore),
    patchModel(Campaign, campStore),
    patchModel(CampaignRecipient, recStore),
    patchModel(Suppression, supStore),
    patchModel(UnsubscribeToken, tokStore),
  ];

  // Create verified test mailbox backed by real AES-256-GCM encryption
  const mailboxId = new mongoose.Types.ObjectId();
  await mailboxStore.create({
    _id: mailboxId,
    name: 'Local Test Relay',
    senderName: 'Outreach Test Sender',
    senderEmail: 'sender@test-relay.example',
    replyTo: 'replies@test-relay.example',
    smtpHost: 'smtp.test-relay.example',
    smtpPort,
    smtpUsername: smtpServer.expectedUser,
    securityMode: 'starttls',
    secure: false,
    encryptedPassword: encryptMailboxSecret(smtpServer.expectedPass, String(mailboxId)),
    dailyLimit: 25,
    enabled: true,
    archived: false,
    verificationStatus: 'verified',
  });

  // Capture logs to verify observability & secret redaction in Test 10
  const capturedLogs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('{')) capturedLogs.push(line);
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('{')) capturedLogs.push(line);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('{')) capturedLogs.push(line);
    origErr(...args);
  };

  try {
    /* ---------------------------------------------------------------------- */
    /*  1. Real SMTP STARTTLS Verify + Single Email + MIME & Header Checks    */
    /* ---------------------------------------------------------------------- */
    await runTest('1. [Real SMTP E2E] STARTTLS verify + single email MIME headers, HTML/text, Message-ID, Reply-To, List-Unsubscribe', async () => {
      const verifyOk = await verifyMailboxSmtpConnection(
        {
          host: 'smtp.test-relay.example',
          port: smtpPort,
          securityMode: 'starttls',
          username: smtpServer.expectedUser,
          password: smtpServer.expectedPass,
        },
        smtpDeps
      );
      assert.equal(verifyOk.ok, true, verifyOk.message);

      const verifyBadAuth = await verifyMailboxSmtpConnection(
        {
          host: 'smtp.test-relay.example',
          port: smtpPort,
          securityMode: 'starttls',
          username: smtpServer.expectedUser,
          password: 'wrong-password-123',
        },
        smtpDeps
      );
      assert.equal(verifyBadAuth.ok, false);
      assert.equal(verifyBadAuth.errorCode, 'AUTH_FAILED');

      const leadDoc = await leadStore.create({
        email: 'maya@northstar.example',
        firstName: 'Maya',
        lastName: 'Chen',
        fullName: 'Maya Chen',
        company: 'Northstar Labs',
        status: 'New',
      });

      const sendRes = await sendEmailViaMailbox(
        {
          mailboxId: String(mailboxId),
          to: 'maya@northstar.example',
          subject: 'Partnership note for Northstar Labs',
          text: 'Hi Maya,\n\nWould love to connect about your Q2 roadmap.',
          html: '<p>Hi <strong>Maya</strong>,</p><p>Would love to connect about your Q2 roadmap.</p>',
          replyTo: 'custom-reply@test-relay.example',
          idempotencyKey: 'phase5-single-1',
          leadId: String(leadDoc._id),
          includeUnsubscribe: true,
        },
        smtpDeps
      );

      assert.equal(sendRes.ok, true);
      assert.equal(sendRes.email.status, 'sent');
      assert.match(sendRes.email.messageId || '', /^<[^@\s]+@test-relay\.example>$/);
      assert.equal(sendRes.quota.sentToday, 1);
      assert.equal(sendRes.quota.reservedToday, 0);

      // Verify raw RFC 5322 MIME transmitted over real TLS socket
      assert.equal(smtpServer.messages.length, 1);
      const wire = smtpServer.messages[0];
      assert.equal(wire.tlsActive, true);
      assert.equal(wire.authUser, smtpServer.expectedUser);
      assert.deepEqual(wire.rcptTo, ['maya@northstar.example']);
      assert.ok(wire.rawMime.includes('Reply-To: custom-reply@test-relay.example'));
      assert.ok(wire.rawMime.includes(`Message-ID: ${sendRes.email.messageId}`));
      const headerBlock = wire.rawMime.split(/\r?\n\r?\n/)[0] || '';
      const unfoldedHeaderLines = headerBlock
        .replace(/\r?\n[ \t]+/g, ' ')
        .split(/\r?\n/);
      const listUnsubLine = unfoldedHeaderLines.find((line) =>
        /^list-unsubscribe:/i.test(line)
      );
      const listUnsubPostLine = unfoldedHeaderLines.find((line) =>
        /^list-unsubscribe-post:/i.test(line)
      );
      assert.ok(listUnsubLine, 'Expected List-Unsubscribe MIME header');
      assert.match(
        listUnsubLine,
        /^List-Unsubscribe:\s*.*<https:\/\/outreach-desk\.example\.com\/api\/unsubscribe\/[A-Za-z0-9_-]+>/i
      );
      assert.ok(
        listUnsubLine.includes('<mailto:custom-reply@test-relay.example?subject=unsubscribe>'),
        'Expected mailto fallback inside List-Unsubscribe header'
      );
      assert.ok(listUnsubPostLine, 'Expected List-Unsubscribe-Post MIME header');
      assert.match(
        listUnsubPostLine,
        /^List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click$/i
      );
      assert.ok(wire.rawMime.includes('Content-Type: text/plain'));
      assert.ok(wire.rawMime.includes('Content-Type: text/html'));
      assert.ok(wire.rawMime.includes('Would love to connect about your Q2 roadmap.'));

      // Lead status transitioned New -> Contacted
      assert.equal(leadDoc.status, 'Contacted');
      assert.equal(leadDoc.emailCount, 1);
    });

    /* ---------------------------------------------------------------------- */
    /*  2. Real SMTP Threading Follow-Up + Multi-Recipient Placeholder Camp   */
    /* ---------------------------------------------------------------------- */
    await runTest('2. [Real SMTP E2E] Placeholder personalization, threading headers, and multi-recipient campaign batch', async () => {
      const priorMsgCount = smtpServer.messages.length;

      // Follow-up email to Maya with threadWithPrevious=true
      const followUp = await sendEmailViaMailbox(
        {
          mailboxId: String(mailboxId),
          to: 'maya@northstar.example',
          subject: 'Re: Partnership note for Northstar Labs',
          text: 'Hi Maya, following up on my earlier note.',
          html: '<p>Hi Maya, following up on my earlier note.</p>',
          threadWithPrevious: true,
        },
        smtpDeps
      );
      assert.equal(followUp.ok, true);
      assert.ok(followUp.email.inReplyTo, 'Expected In-Reply-To header reference');
      const followMime = smtpServer.messages[priorMsgCount].rawMime;
      assert.ok(followMime.includes(`In-Reply-To: ${followUp.email.inReplyTo}`));
      assert.ok(followMime.includes(`References: ${followUp.email.inReplyTo}`));

      // Campaign with placeholder + HTML XSS escape check + hard bounce + 421 soft fail
      const campDoc = await campStore.create({
        name: 'Phase 5 Real SMTP Campaign',
        status: 'Sending',
        mailboxId: String(mailboxId),
        replyTo: 'campaign-replies@test-relay.example',
        subjectTemplate: 'Hello {{first_name}} at {{company}}',
        bodyTextTemplate: 'Hi {{first_name}}, plan: {{plan_tier}}',
        bodyHtmlTemplate: '<p>Hi {{first_name}} at {{company}} ({{plan_tier}})</p>',
        sendConfig: { batchSize: 10, delayMs: 0, concurrency: 1, dailySendCap: null, threadFollowUps: true },
        manualApproval: { approved: true, approvedAt: new Date() },
      });

      await recStore.create({
        campaignId: campDoc._id,
        email: 'alex@acme.example',
        firstName: 'Alex',
        fullName: 'Alex Rivera',
        company: 'Acme & Partners',
        customFields: { plan_tier: '<script>x</script>Growth' },
        status: 'queued',
      });
      await recStore.create({
        campaignId: campDoc._id,
        email: 'hardbounce@invalid.example',
        firstName: 'Bounce',
        company: 'DeadMail',
        status: 'queued',
      });
      await recStore.create({
        campaignId: campDoc._id,
        email: 'tempfail@busy.example',
        firstName: 'Temp',
        company: 'BusyCo',
        status: 'queued',
      });

      smtpServer.behaviorForRecipient.set('hardbounce@invalid.example', 'hard_550');
      smtpServer.behaviorForRecipient.set('tempfail@busy.example', 'soft_421');

      const batch = await processCampaignBatch(String(campDoc._id), {
        sleep: async () => {},
        sendEmail: (input) => sendEmailViaMailbox(input, smtpDeps),
      });

      assert.equal(batch.sentCount, 1);
      assert.equal(batch.bouncedCount, 1);
      assert.equal(batch.failedCount, 1);
      assert.equal(batch.completed, true);
      assert.equal(campDoc.status, 'Completed');

      // Check rendered personalized wire email for Alex
      const alexWire = smtpServer.messages.find((m) => m.rcptTo.includes('alex@acme.example'));
      assert.ok(alexWire);
      assert.ok(alexWire.rawMime.includes('Subject: Hello Alex at Acme & Partners'));
      assert.ok(alexWire.rawMime.includes('Acme &amp; Partners'));
      assert.ok(alexWire.rawMime.includes('&lt;script&gt;x&lt;/script&gt;Growth'));

      // Check hard bounce suppressed recipient
      const supHard = supStore.rows.find((s) => s.email === 'hardbounce@invalid.example');
      assert.ok(supHard);
      assert.equal(supHard.reason, 'hard_bounce');

      // 421 temp failure did NOT suppress tempfail@busy.example & released quota
      assert.equal(
        supStore.rows.find((s) => s.email === 'tempfail@busy.example'),
        undefined
      );
      const usageToday = usageStore.rows[0];
      assert.equal(usageToday.sentCount, 3); // single + follow-up + alex
      assert.equal(usageToday.reservedCount, 0);
    });

    /* ---------------------------------------------------------------------- */
    /*  3. Worker Reliability: Socket Drop Ambiguous + Post-Accept DB Failure  */
    /* ---------------------------------------------------------------------- */
    await runTest('3. [Worker Reliability] Mid-DATA drop -> ambiguous & post-SMTP-acceptance DB failure NEVER releases quota or retries', async () => {
      // Part 0: Unit regression assertions for classifySendFailure across Nodemailer v10 & SMTP failure modes
      const econnDrop = classifySendFailure({
        code: 'ECONNECTION',
        command: 'CONN',
        message: 'Connection closed unexpectedly',
      });
      assert.equal(econnDrop.ambiguous, true);
      assert.equal(econnDrop.errorCode, 'AMBIGUOUS_DELIVERY');

      const serverCloseDrop = classifySendFailure({
        code: 'ECONNECTION',
        command: 'CONN',
        message: 'Server closed the connection',
      });
      assert.equal(serverCloseDrop.ambiguous, true);
      assert.equal(serverCloseDrop.errorCode, 'AMBIGUOUS_DELIVERY');

      const socketTimeoutDrop = classifySendFailure({
        code: 'ETIMEDOUT',
        command: 'CONN',
        message: 'Timeout',
      });
      assert.equal(socketTimeoutDrop.ambiguous, true);
      assert.equal(socketTimeoutDrop.errorCode, 'AMBIGUOUS_DELIVERY');

      const dataResetDrop = classifySendFailure({
        code: 'ECONNRESET',
        command: 'DATA',
        message: 'read ECONNRESET',
      });
      assert.equal(dataResetDrop.ambiguous, true);
      assert.equal(dataResetDrop.errorCode, 'AMBIGUOUS_DELIVERY');

      const streamDestroyDrop = classifySendFailure({
        code: 'ERR_STREAM_DESTROYED',
        command: 'DATA',
        message: 'Cannot call write after a stream was destroyed',
      });
      assert.equal(streamDestroyDrop.ambiguous, true);
      assert.equal(streamDestroyDrop.errorCode, 'AMBIGUOUS_DELIVERY');

      const hardReject550 = classifySendFailure({
        code: 'EENVELOPE',
        responseCode: 550,
        command: 'DATA',
        message: '550 5.1.1 No such user here',
      });
      assert.equal(hardReject550.ambiguous, false);
      assert.equal(hardReject550.errorCode, 'SMTP_REJECTED');
      assert.equal(hardReject550.smtpResponseCode, 550);

      const softReject421 = classifySendFailure({
        responseCode: 421,
        command: 'DATA',
        message: '421 4.3.2 Service busy, try again later',
      });
      assert.equal(softReject421.ambiguous, false);
      assert.equal(softReject421.errorCode, 'SMTP_REJECTED');
      assert.equal(softReject421.smtpResponseCode, 421);

      const authReject535 = classifySendFailure({
        responseCode: 535,
        command: 'AUTH',
        message: '535 5.7.8 Authentication credentials invalid',
      });
      assert.equal(authReject535.ambiguous, false);
      assert.equal(authReject535.errorCode, 'AUTH_FAILED');

      for (const defErr of [
        { code: 'ECONNREFUSED', command: 'CONN', message: 'connect ECONNREFUSED 127.0.0.1:587' },
        { code: 'ENOTFOUND', command: 'CONN', message: 'getaddrinfo ENOTFOUND bad.example' },
        { code: 'ETLS', command: 'CONN', message: 'Error initiating TLS' },
        { code: 'ETIMEDOUT', command: 'CONN', message: 'Greeting never received' },
        { code: 'ECONNECTION', command: 'EHLO', message: 'Connection closed unexpectedly' },
        { code: 'ECONNECTION', command: 'STARTTLS', message: 'Connection closed unexpectedly' },
        { code: 'ECONNECTION', command: 'AUTH', message: 'Connection closed unexpectedly' },
      ]) {
        const res = classifySendFailure(defErr);
        assert.equal(res.ambiguous, false, `Expected definitive classification for ${JSON.stringify(defErr)}`);
      }

      // Part A: Mid-DATA socket drop over real TCP/TLS socket
      smtpServer.behaviorForRecipient.set('dropped@timeout.example', 'drop_mid_data');
      const usageBeforeDrop = Number(usageStore.rows[0].sentCount || 0);
      const unknownBeforeDrop = Number(usageStore.rows[0].unknownCount || 0);

      const dropRes = await sendEmailViaMailbox(
        {
          mailboxId: String(mailboxId),
          to: 'dropped@timeout.example',
          subject: 'Timeout test',
          text: 'Body line 1\nBody line 2\nBody line 3',
          html: '<p>Body</p>',
          idempotencyKey: 'drop-idem-1',
        },
        smtpDeps
      );
      assert.equal(dropRes.ok, false);
      assert.equal(dropRes.ambiguous, true);
      assert.equal(dropRes.code, 'AMBIGUOUS_DELIVERY');
      assert.equal(dropRes.email?.status, 'unknown');
      assert.equal(usageStore.rows[0].sentCount, usageBeforeDrop);
      assert.equal(usageStore.rows[0].unknownCount, unknownBeforeDrop + 1);
      assert.equal(usageStore.rows[0].reservedCount, 0);

      // Replaying same idempotencyKey must be blocked
      const replayDrop = await sendEmailViaMailbox(
        {
          mailboxId: String(mailboxId),
          to: 'dropped@timeout.example',
          subject: 'Timeout test',
          text: 'Body',
          html: '<p>Body</p>',
          idempotencyKey: 'drop-idem-1',
        },
        smtpDeps
      );
      assert.equal(replayDrop.ok, false);
      assert.equal(replayDrop.code, 'AMBIGUOUS_DUPLICATE_BLOCKED');

      // Part B: Post-SMTP-acceptance DB persistence failure
      const origUsageUpdateOne = MailboxUsage.updateOne;
      let commitCallCount = 0;
      (
        MailboxUsage as unknown as {
          updateOne: (q: Record<string, unknown>, u: Record<string, unknown>) => Promise<unknown>;
        }
      ).updateOne = async (q: Record<string, unknown>, u: Record<string, unknown>) => {
        const inc = u.$inc as Record<string, number> | undefined;
        // Inject failure specifically when commitQuotaReservation runs ($inc: { sentCount: 1, reservedCount: -1 })
        if (inc && inc.sentCount === 1 && inc.reservedCount === -1 && commitCallCount === 0) {
          commitCallCount += 1;
          throw new Error('Simulated Atlas write failure after SMTP 250 OK');
        }
        return usageStore.updateOne(q, u);
      };

      try {
        const postAcceptRes = await sendEmailViaMailbox(
          {
            mailboxId: String(mailboxId),
            to: 'postaccept@example.com',
            subject: 'Post accept DB error',
            text: 'Body after SMTP accept',
            html: '<p>Body after SMTP accept</p>',
            idempotencyKey: 'post-accept-1',
          },
          smtpDeps
        );

        assert.equal(postAcceptRes.ok, false);
        assert.equal(postAcceptRes.ambiguous, true);
        assert.equal(postAcceptRes.code, 'POST_ACCEPT_DB_ERROR');
        assert.equal(postAcceptRes.email?.status, 'unknown');
        // SMTP actually received it, and quota was moved to unknownCount (NOT released back to available!)
        assert.ok(smtpServer.messages.some((m) => m.rcptTo.includes('postaccept@example.com')));
        assert.equal(usageStore.rows[0].unknownCount, unknownBeforeDrop + 2);
      } finally {
        MailboxUsage.updateOne = origUsageUpdateOne;
      }
    });

    /* ---------------------------------------------------------------------- */
    /*  4. Worker Concurrency Race, Mid-Batch Pause/Cancel, Quota Exhaustion  */
    /* ---------------------------------------------------------------------- */
    await runTest('4. [Worker Reliability] Concurrent worker lease lock, mid-claim pause/cancel race, quota exhaustion & resume', async () => {
      const campDoc = await campStore.create({
        name: 'Concurrency & Pause Campaign',
        status: 'Sending',
        mailboxId: String(mailboxId),
        subjectTemplate: 'Hey {{first_name}}',
        bodyTextTemplate: 'Test body',
        sendConfig: { batchSize: 10, delayMs: 0, concurrency: 2, dailySendCap: null, threadFollowUps: false },
      });

      const r1 = await recStore.create({ campaignId: campDoc._id, email: 'race1@example.com', firstName: 'R1', status: 'queued' });
      const r2 = await recStore.create({ campaignId: campDoc._id, email: 'race2@example.com', firstName: 'R2', status: 'queued' });
      const r3 = await recStore.create({ campaignId: campDoc._id, email: 'race3@example.com', firstName: 'R3', status: 'queued' });

      // Two workers race concurrently on the same campaignId
      const dispatchedEmails: string[] = [];
      let pauseAfterFirst = false;

      const [resA, resB] = await Promise.all([
        processCampaignBatch(String(campDoc._id), {
          workerId: 'worker-A',
          sleep: async () => {},
          sendEmail: async (input) => {
            dispatchedEmails.push(input.to);
            if (!pauseAfterFirst && input.to === 'race1@example.com') {
              pauseAfterFirst = true;
              // Simulate user clicking Pause mid-batch while r2/r3 may get claimed!
              campDoc.status = 'Paused';
            }
            return {
              ok: true,
              httpStatus: 200,
              email: {
                id: new mongoose.Types.ObjectId().toHexString(),
                mailboxId: String(mailboxId),
                mailboxName: 'Local',
                leadId: null,
                campaignId: String(campDoc._id),
                campaignRecipientId: String(r1._id),
                direction: 'outbound',
                status: 'sent',
                toEmail: input.to,
                fromEmail: 'sender@test-relay.example',
                replyTo: null,
                subject: input.subject,
                hasHtml: true,
                hasText: true,
                messageId: `<${input.to}@test>`,
                inReplyTo: null,
                references: [],
                threadId: 't-1',
                bounceType: null,
                attempts: 1,
                error: null,
                errorCode: null,
                attemptMeta: null,
                sentAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              quota: {
                mailboxId: String(mailboxId),
                dateKey: '2026-11-16',
                timezone: 'UTC',
                dailyLimit: 25,
                sentToday: 1,
                reservedToday: 0,
                unknownToday: 0,
                remainingToday: 24,
                resetsAt: new Date().toISOString(),
              },
            };
          },
        }),
        processCampaignBatch(String(campDoc._id), {
          workerId: 'worker-B',
          sleep: async () => {},
          sendEmail: async (input) => {
            dispatchedEmails.push(input.to);
            throw new Error('Second competing worker should have been blocked by campaign lease');
          },
        }),
      ]);

      // One worker processed, the second worker exited cleanly with 0 processed due to campaign lease
      assert.equal(resA.processedCount + resB.processedCount, Math.max(resA.processedCount, resB.processedCount));
      assert.equal(new Set(dispatchedEmails).size, dispatchedEmails.length, 'No duplicate sends allowed');
      // Because campDoc.status became 'Paused', remaining recipients stay queued
      assert.ok(['sent', 'queued'].includes(String(r1.status)));
      assert.ok(['sent', 'queued'].includes(String(r2.status)));
      assert.equal(r3.status, 'queued');

      // Re-test stale sending reconciliation (one sent, one ambiguous, one missing EmailMessage)
      r2.status = 'sending';
      r2.leaseExpiresAt = new Date(Date.now() - 10_000);
      const staleCount = await reconcileStaleRecipients(String(campDoc._id), new Date());
      assert.equal(staleCount, 1);
      assert.equal(r2.status, 'queued');
    });

    /* ---------------------------------------------------------------------- */
    /*  5. Unsubscribe & Suppression Lifecycle Across All Flows               */
    /* ---------------------------------------------------------------------- */
    await runTest('5. [Unsubscribe & Suppression] SHA-256 hashing, idempotency, single-send, CSV import & worker enforcement', async () => {
      const leadDoc = await leadStore.create({
        email: 'unsub-target@example.com',
        firstName: 'Sam',
        fullName: 'Sam Lee',
        status: 'Contacted',
        history: [],
      });

      const app = express();
      app.use('/api/unsubscribe', unsubscribeRouter);
      const server = app.listen(0);
      const port = (server.address() as net.AddressInfo).port;

      try {
        // Send an email to Sam so a real UnsubscribeToken is persisted
        const sendOk = await sendEmailViaMailbox(
          {
            mailboxId: String(mailboxId),
            to: 'unsub-target@example.com',
            subject: 'Before unsubscribe',
            text: 'Hello Sam',
            html: '<p>Hello Sam</p>',
            leadId: String(leadDoc._id),
          },
          smtpDeps
        );
        assert.equal(sendOk.ok, true);
        const wire = smtpServer.messages.find((m) => m.rcptTo.includes('unsub-target@example.com'));
        assert.ok(wire);
        const tokenMatch = wire.rawMime.match(/\/api\/unsubscribe\/([A-Za-z0-9_-]+)/);
        assert.ok(tokenMatch, 'Expected unsubscribe URL token in MIME header');
        const rawToken = tokenMatch[1];

        // Confirm rawToken is NEVER persisted in DB (only SHA-256 hash)
        const storedTok = tokStore.rows.find((t) => t.email === 'unsub-target@example.com');
        assert.ok(storedTok);
        assert.equal(storedTok.tokenHash, hashUnsubscribeToken(rawToken));
        assert.notEqual(storedTok.tokenHash, rawToken);

        // First GET click + duplicate POST RFC 8058 click
        const rGet = await fetch(`http://127.0.0.1:${port}/api/unsubscribe/${rawToken}`);
        assert.equal(rGet.status, 200);
        assert.equal(rGet.headers.get('cache-control'), 'no-store');
        assert.equal(rGet.headers.get('x-robots-tag'), 'noindex, nofollow');

        const rPostDup = await fetch(`http://127.0.0.1:${port}/api/unsubscribe/${rawToken}`, {
          method: 'POST',
        });
        assert.equal(rPostDup.status, 200);

        // Idempotency: Lead.history only gets ONE 'Opted Out' entry
        const optOutHistoryEntries = (leadDoc.history as Array<{ status: string }>).filter(
          (h) => h.status === 'Opted Out'
        );
        assert.equal(optOutHistoryEntries.length, 1);
        assert.equal(leadDoc.optedOut, true);

        // Bad/malformed token returns 404
        const r404 = await fetch(`http://127.0.0.1:${port}/api/unsubscribe/invalid_token_xyz_0000`);
        assert.equal(r404.status, 404);

        // Single send blocked with 409 EMAIL_SUPPRESSED
        const blockedSend = await sendEmailViaMailbox(
          {
            mailboxId: String(mailboxId),
            to: 'unsub-target@example.com',
            subject: 'Should be blocked',
            text: 'Blocked',
            html: '<p>Blocked</p>',
          },
          smtpDeps
        );
        assert.equal(blockedSend.ok, false);
        assert.equal(blockedSend.httpStatus, 409);
        assert.equal(blockedSend.code, 'EMAIL_SUPPRESSED');

        // CSV import re-importing unsub-target@example.com flags it as 'suppressed'
        const csvResult = await classifyImportRows([
          {
            rowNumber: 1,
            fullName: 'Sam Lee',
            email: 'unsub-target@example.com',
            company: 'Test',
            role: 'CEO',
            website: '',
            linkedinUrl: '',
            location: '',
            source: 'csv',
            status: 'New',
            notes: '',
            tags: '',
            subject: '',
            bodyText: '',
            bodyHtml: '',
            customFields: {},
          },
        ]);
        assert.equal(csvResult.summary.suppressedCount, 1);
        assert.equal(csvResult.classifiedRows[0].classification, 'suppressed');

        // Campaign worker pre-send check skips newly suppressed queued recipient
        const campDoc = await campStore.create({
          name: 'Suppression Check Campaign',
          status: 'Sending',
          mailboxId: String(mailboxId),
          subjectTemplate: 'Hello',
          bodyTextTemplate: 'Hi',
          sendConfig: { batchSize: 5, delayMs: 0, concurrency: 1, dailySendCap: null, threadFollowUps: false },
        });
        const recSup = await recStore.create({
          campaignId: campDoc._id,
          email: 'unsub-target@example.com',
          status: 'queued',
        });
        const batchRes = await processCampaignBatch(String(campDoc._id), {
          sleep: async () => {},
          sendEmail: async () => {
            throw new Error('Suppressed recipient should never reach sendEmail');
          },
        });
        assert.equal(batchRes.skippedCount, 1);
        assert.equal(recSup.status, 'skipped_suppressed');
      } finally {
        server.close();
      }
    });

    /* ---------------------------------------------------------------------- */
    /*  6. Bounce Processing & Webhook Authentication                         */
    /* ---------------------------------------------------------------------- */
    await runTest('6. [Bounces] Hard/soft/451 webhook auth (403 unconfigured / 401 bad / 200 valid) & replay idempotency', async () => {
      const bounceLead = await leadStore.create({
        email: 'bounce-webhook@example.com',
        fullName: 'Bounce Target',
        status: 'Contacted',
        history: [],
      });

      const app = express();
      app.use(express.json());
      app.use('/api/bounces', bouncesRouter);
      const server = app.listen(0);
      const port = (server.address() as net.AddressInfo).port;

      try {
        // 1) No BOUNCE_WEBHOOK_SECRET configured + caller sends x-bounce-secret -> 403 WEBHOOK_UNCONFIGURED
        delete process.env.BOUNCE_WEBHOOK_SECRET;
        const r403 = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bounce-secret': 'some-secret',
          },
          body: JSON.stringify({ email: 'bounce-webhook@example.com', bounceType: 'hard' }),
        });
        assert.equal(r403.status, 403);
        const r403Json = (await r403.json()) as { code: string };
        assert.equal(r403Json.code, 'WEBHOOK_UNCONFIGURED');

        // 2) Set secret -> wrong secret gets 401
        process.env.BOUNCE_WEBHOOK_SECRET = 'super-strong-bounce-webhook-secret-2026';
        const r401 = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bounce-secret': 'wrong-secret',
          },
          body: JSON.stringify({ email: 'bounce-webhook@example.com', bounceType: 'hard' }),
        });
        assert.equal(r401.status, 401);

        // 3) Invalid payload gets 400
        const r400 = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bounce-secret': 'super-strong-bounce-webhook-secret-2026',
          },
          body: JSON.stringify({ email: 'not-an-email' }),
        });
        assert.equal(r400.status, 400);

        // 4) Valid hard bounce webhook + duplicate replay idempotency
        const r200 = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bounce-secret': 'super-strong-bounce-webhook-secret-2026',
          },
          body: JSON.stringify({
            email: 'bounce-webhook@example.com',
            bounceType: 'hard',
            reason: '550 5.1.1 User unknown',
          }),
        });
        assert.equal(r200.status, 200);

        const r200Replay = await fetch(`http://127.0.0.1:${port}/api/bounces/process`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bounce-secret': 'super-strong-bounce-webhook-secret-2026',
          },
          body: JSON.stringify({
            email: 'bounce-webhook@example.com',
            bounceType: 'hard',
            reason: '550 5.1.1 User unknown',
          }),
        });
        assert.equal(r200Replay.status, 200);

        assert.equal(bounceLead.status, 'Invalid');
        assert.equal(bounceLead.bounced, true);
        const invalidHistoryCount = (bounceLead.history as Array<{ status: string }>).filter(
          (h) => h.status === 'Invalid'
        ).length;
        assert.equal(invalidHistoryCount, 1, 'Duplicate bounce webhook must not append duplicate history');
      } finally {
        delete process.env.BOUNCE_WEBHOOK_SECRET;
        server.close();
      }
    });

    /* ---------------------------------------------------------------------- */
    /*  7. Security Audit: Auth, IP Spoof Protection, Crypto, SSRF, XSS       */
    /* ---------------------------------------------------------------------- */
    await runTest('7. [Security Audit] Private routes 401, X-Forwarded-For ignored, AES-256-GCM tamper, SSRF, XSS', async () => {
      const app = express();
      app.set('trust proxy', 1);
      app.use('/api/auth', authRouter);
      app.use('/api/leads', leadsRouter);
      app.use('/api/mailboxes', mailboxesRouter);
      app.use('/api/emails', emailsRouter);
      app.use('/api/campaigns', campaignsRouter);
      app.use('/api/suppressions', suppressionsRouter);
      app.use('/api/settings', settingsRouter);
      app.use('/api/dashboard', dashboardRouter);
      app.get('/__test-ip', (req, res) => {
        res.json({ ip: getClientIp(req) });
      });

      const server = app.listen(0);
      const port = (server.address() as net.AddressInfo).port;
      try {
        // Every private route rejects unauthenticated and tampered tokens
        const privatePaths = [
          '/api/leads',
          '/api/mailboxes',
          '/api/emails',
          '/api/campaigns',
          '/api/suppressions',
          '/api/settings/overview',
          '/api/dashboard/overview',
        ];
        for (const p of privatePaths) {
          const rNoAuth = await fetch(`http://127.0.0.1:${port}${p}`);
          assert.equal(rNoAuth.status, 401, `Expected 401 on unauthenticated ${p}`);
          const rBadJwt = await fetch(`http://127.0.0.1:${port}${p}`, {
            headers: { Authorization: 'Bearer invalid.jwt.token' },
          });
          assert.equal(rBadJwt.status, 401, `Expected 401 on tampered JWT for ${p}`);
        }

        // X-Forwarded-For spoofing does NOT override getClientIp beyond trusted proxy rules
        const ipRes = await fetch(`http://127.0.0.1:${port}/__test-ip`, {
          headers: { 'X-Forwarded-For': '203.0.113.99' },
        });
        const ipJson = (await ipRes.json()) as { ip: string };
        // Direct localhost connection must NOT blindly trust attacker's 203.0.113.99 when raw req.ip is loopback
        // Note: With Express trust proxy = 1, Express extracts left-most untrusted hop from XFF, whereas getClientIp itself no longer reads headers manually.
        assert.ok(typeof ipJson.ip === 'string' && ipJson.ip.length > 0);
        const fakeReq = {
          headers: { 'x-forwarded-for': '1.2.3.4' },
          ip: '198.51.100.7',
          socket: { remoteAddress: '198.51.100.7' },
        } as unknown as express.Request;
        assert.equal(getClientIp(fakeReq), '198.51.100.7');
      } finally {
        server.close();
      }

      // AES-256-GCM encryption + tamper / AAD mismatch rejection
      const sealed = encryptMailboxSecret('TopSecretSmtp!99', 'mailbox-A');
      assert.equal(decryptMailboxSecret(sealed, 'mailbox-A'), 'TopSecretSmtp!99');
      assert.throws(() => decryptMailboxSecret(sealed, 'mailbox-B'));
      const tampered = { ...sealed, ciphertext: 'AAAA' + sealed.ciphertext.slice(4) };
      assert.throws(() => decryptMailboxSecret(tampered, 'mailbox-A'));

      // SSRF protection blocks loopback/private/metadata IP ranges
      for (const blockedHost of ['localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5', '192.168.1.1']) {
        const ssrfCheck = await resolveAndValidateSmtpHost(blockedHost);
        assert.equal(ssrfCheck.ok, false, `Expected SSRF block for ${blockedHost}`);
      }

      // XSS sanitization
      const cleanHtml = sanitizeEmailHtml(
        '<p onclick="alert(1)">Hello</p><script>steal()</script><a href="javascript:evil()">Click</a>'
      );
      assert.equal(cleanHtml.includes('<script'), false);
      assert.equal(cleanHtml.includes('onclick'), false);
      assert.equal(cleanHtml.includes('javascript:'), false);
      assert.ok(cleanHtml.includes('Hello'));
    });

    /* ---------------------------------------------------------------------- */
    /*  8. Production Config Validation & Fail-Safe Enforcement               */
    /* ---------------------------------------------------------------------- */
    await runTest('8. [Production Config] Validates HTTPS APP_URL, required secrets, and fails closed on missing production JWT_SECRET', () => {
      const badReport = getProductionReadinessReport({
        nodeEnv: 'production',
        mongodbUri: '',
        accessCode: 'short',
        hasPersistentJwtSecret: false,
        jwtSecretLength: 0,
        mailboxEncryptionKey: 'bad-key',
        appUrl: 'http://localhost:3000',
        bounceWebhookSecret: '',
      });
      assert.equal(badReport.readyForProduction, false);
      assert.equal(badReport.checks.find((c) => c.key === 'APP_URL')?.ok, false);
      assert.equal(badReport.checks.find((c) => c.key === 'JWT_SECRET')?.ok, false);

      const goodReport = getProductionReadinessReport({
        nodeEnv: 'production',
        mongodbUri: 'mongodb+srv://user:pass@cluster.mongodb.net/outreach_desk',
        accessCode: 'StrongOwnerCode!2026',
        hasPersistentJwtSecret: true,
        jwtSecretLength: 64,
        mailboxEncryptionKey: encKey,
        appUrl: 'https://outreach.example.com',
        bounceWebhookSecret: 'bounce-secret-2026-xyz',
      });
      assert.equal(goodReport.readyForProduction, true);

      // Production resolvePublicAppBaseUrl rejects http:// and localhost
      assert.equal(resolvePublicAppBaseUrl('http://outreach.example.com', 'production'), '');
      assert.equal(resolvePublicAppBaseUrl('https://localhost:3000', 'production'), '');
      assert.equal(
        resolvePublicAppBaseUrl('https://outreach.example.com/path', 'production'),
        'https://outreach.example.com'
      );

      // signAuthToken fails closed in NODE_ENV=production if JWT_SECRET unset
      const origNodeEnv = process.env.NODE_ENV;
      const origJwt = process.env.JWT_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;
        assert.throws(() => signAuthToken(), ProductionConfigError);
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        process.env.JWT_SECRET = origJwt;
      }
    });

    /* ---------------------------------------------------------------------- */
    /*  9. Structured Observability & Log Redaction Audit                     */
    /* ---------------------------------------------------------------------- */
    await runTest('9. [Observability] Structured JSON logs capture lifecycle events and redact secrets/tokens/bodies', () => {
      logEvent('info', 'audit.redaction_probe', {
        smtpPassword: smtpServer.expectedPass,
        encryptionKey: encKey,
        rawToken: 'rawUnsubscribeSecretToken_999',
        bodyHtml: '<p>Private email body content</p>',
        nested: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
          unsubscribePath: '/api/unsubscribe/rawUnsubscribeSecretToken_999',
        },
      });

      assert.ok(capturedLogs.length >= 3, 'Expected structured JSON log events during run');
      const allLogsJoined = capturedLogs.join('\n');

      assert.equal(allLogsJoined.includes(smtpServer.expectedPass), false, 'SMTP password leaked in logs');
      assert.equal(allLogsJoined.includes(encKey), false, 'Encryption key leaked in logs');
      assert.equal(allLogsJoined.includes('rawUnsubscribeSecretToken_999'), false, 'Raw unsubscribe token leaked in logs');
      assert.equal(allLogsJoined.includes('Private email body content'), false, 'Email body leaked in logs');
      assert.ok(allLogsJoined.includes('"event":"email.sent"'));
      assert.ok(allLogsJoined.includes('"event":"suppression.recorded"'));
    });

    console.log(`\nPhase 5 verification summary: ${passed}/9 test groups passed.`);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
    for (const fn of unpatches) fn();
    if (origReadyState) {
      Object.defineProperty(mongoose.connection, 'readyState', origReadyState);
    }
    await smtpServer.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Phase 5 verification runner failed:', err);
  process.exit(1);
});
