import mongoose from 'mongoose';
import { getEnvConfig } from './env.ts';

export type DatabaseConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting';

export interface DatabaseStatus {
  configured: boolean;
  connected: boolean;
  state: DatabaseConnectionState;
  lastError: string | null;
}

let lastDbError: string | null = null;
let listenersAttached = false;
let isConnectingAttempt = false;

function formatMongoError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'MongoDB connection error');
  const lower = raw.toLowerCase();

  if (
    lower.includes('tlsv1 alert internal error') ||
    lower.includes('ssl alert number 80') ||
    lower.includes('not whitelisted') ||
    lower.includes('whitelist')
  ) {
    return 'MongoDB Atlas rejected the TLS connection. In MongoDB Atlas -> Network Access, add 0.0.0.0/0 to your IP Access List (required for cloud-hosted apps) and confirm your cluster is not paused.';
  }

  if (lower.includes('authentication failed') || lower.includes('bad auth')) {
    return 'MongoDB Atlas authentication failed. Verify the database username and password in MONGODB_URI (URL-encode special characters in the password).';
  }

  if (lower.includes('querysrv') || lower.includes('enotfound')) {
    return 'Could not resolve the MongoDB Atlas cluster hostname. Verify the cluster address in MONGODB_URI.';
  }

  return raw.split('\n')[0].trim();
}

function mapReadyState(readyState: number, configured: boolean): DatabaseConnectionState {
  if (!configured) return 'unconfigured';
  switch (readyState) {
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'disconnected';
  }
}

export function getDatabaseStatus(): DatabaseStatus {
  const { mongodbUri } = getEnvConfig();
  const configured = Boolean(mongodbUri);
  const state = mapReadyState(mongoose.connection.readyState, configured);

  return {
    configured,
    connected: state === 'connected',
    state,
    lastError: lastDbError,
  };
}

export async function connectDatabase(): Promise<boolean> {
  const { mongodbUri } = getEnvConfig();
  if (!mongodbUri) {
    lastDbError = 'MONGODB_URI is not configured.';
    console.warn('[Outreach Desk] MONGODB_URI is not set. Database features are disabled until configured.');
    return false;
  }

  if (mongoose.connection.readyState === 1) {
    lastDbError = null;
    return true;
  }

  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on('connected', () => {
      lastDbError = null;
      console.log('[Outreach Desk] Connected to MongoDB Atlas.');
    });
    mongoose.connection.on('error', (err) => {
      const formatted = formatMongoError(err);
      lastDbError = formatted;
      if (!isConnectingAttempt) {
        console.warn('[Outreach Desk] MongoDB connection warning:', formatted);
      }
    });
    mongoose.connection.on('disconnected', () => {
      if (!isConnectingAttempt) {
        console.warn('[Outreach Desk] MongoDB disconnected.');
      }
    });
  }

  isConnectingAttempt = true;
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect().catch(() => {});
    }

    await mongoose.connect(mongodbUri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      family: 4,
    });
    lastDbError = null;
    const { verifyLeadEmailIntegrity } = await import('../utils/leadIntegrity.ts');
    const integrity = await verifyLeadEmailIntegrity();
    console.log(`[Outreach Desk] Lead index check (${integrity.status}): ${integrity.message}`);
    return true;
  } catch (err) {
    lastDbError = formatMongoError(err);
    console.warn('[Outreach Desk] MongoDB Atlas unavailable:', lastDbError);
    return false;
  } finally {
    isConnectingAttempt = false;
  }
}
