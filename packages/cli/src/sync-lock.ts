import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

/** Serialize the complete scan/upload/config-write cycle across CLI processes. */
export async function withSyncLock<T>(
  configPath: string,
  operation: () => Promise<T>,
  busyMessage = 'Another sync is running. Wait for it to finish before retrying.',
): Promise<T> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(configPath, {
      realpath: false,
      lockfilePath: `${configPath}.sync.lock`,
      stale: 300_000,
      update: 10_000,
      retries: 0,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new Error(busyMessage);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}
