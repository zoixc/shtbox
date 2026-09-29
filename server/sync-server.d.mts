import type { Server } from 'node:http';
export interface SyncServerOptions {
  dataDir?: string;
  maxBytes?: number;
  maxEntries?: number;
  invite?: string;
  ratePerMin?: number;
  trustProxy?: boolean;
}
export function createSyncServer(opts?: SyncServerOptions): Server;
