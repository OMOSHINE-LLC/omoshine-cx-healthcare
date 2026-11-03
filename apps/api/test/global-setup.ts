import { execFileSync } from 'node:child_process';
import { chownSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { GlobalSetupContext } from 'vitest/node';
import { migrate } from '../src/migrate.js';

/**
 * Start a throwaway PostgreSQL cluster for integration tests, unless
 * TEST_ADMIN_DATABASE_URL / TEST_DATABASE_URL point at an existing one (CI).
 */
const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
let dataDir: string | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      s.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

function asPgUser(cmd: string, args: string[]) {
  // initdb refuses to run as root; drop to an unprivileged user when needed.
  if (process.getuid?.() === 0) {
    const user = process.env.PG_RUN_AS ?? 'claude';
    return execFileSync('runuser', ['-u', user, '--', cmd, ...args], { stdio: 'pipe' });
  }
  return execFileSync(cmd, args, { stdio: 'pipe' });
}

export default async function setup({ provide }: GlobalSetupContext) {
  let adminUrl = process.env.TEST_ADMIN_DATABASE_URL;
  let appUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl || !appUrl) {
    if (!existsSync(join(PG_BIN, 'initdb'))) throw new Error(`PostgreSQL binaries not found at ${PG_BIN}; set PG_BIN or TEST_*_DATABASE_URL`);
    dataDir = mkdtempSync(join(tmpdir(), 'omoshine-pg-'));
    if (process.getuid?.() === 0) {
      const uid = Number(execFileSync('id', ['-u', process.env.PG_RUN_AS ?? 'claude']).toString().trim());
      const gid = Number(execFileSync('id', ['-g', process.env.PG_RUN_AS ?? 'claude']).toString().trim());
      chownSync(dataDir, uid, gid);
    }
    const port = await freePort();
    asPgUser(join(PG_BIN, 'initdb'), ['-D', join(dataDir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8']);
    asPgUser(join(PG_BIN, 'pg_ctl'), ['-D', join(dataDir, 'data'), '-l', join(dataDir, 'pg.log'), '-w', '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start']);
    asPgUser(join(PG_BIN, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', 'omoshine_test']);
    adminUrl = `postgres://postgres@127.0.0.1:${port}/omoshine_test`;
    appUrl = `postgres://omoshine_app:omoshine_app@127.0.0.1:${port}/omoshine_test`;
  }
  await migrate(adminUrl);
  provide('adminUrl', adminUrl);
  provide('appUrl', appUrl);

  return async () => {
    if (dataDir) {
      try {
        asPgUser(join(PG_BIN, 'pg_ctl'), ['-D', join(dataDir, 'data'), '-m', 'immediate', 'stop']);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}
