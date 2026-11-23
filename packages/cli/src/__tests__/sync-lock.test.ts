import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withSyncLock } from '../sync-lock.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'aiusage-sync-lock-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('sync snapshot serialization', () => {
  it('prevents a second snapshot from scanning/uploading until the running cycle finishes', async () => {
    const path = join(dir, 'config.json');
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const first = withSyncLock(path, async () => { enter(); await gate; });
    await entered;
    let secondRan = false;
    try {
      await expect(withSyncLock(path, async () => { secondRan = true; })).rejects.toThrow('Another sync');
      expect(secondRan).toBe(false);
    } finally { finish(); await first; }
    expect(await withSyncLock(path, async () => 'new snapshot')).toBe('new snapshot');
  });

  it('releases the lock after a failed scan or upload', async () => {
    const path = join(dir, 'config.json');
    await expect(withSyncLock(path, async () => { throw new Error('upload failed'); })).rejects.toThrow('upload failed');
    expect(await withSyncLock(path, async () => 42)).toBe(42);
  });

  it('rejects another real process and releases on its exit', async () => {
    const path = join(dir, 'config.json');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import lockfile from 'proper-lockfile';
      await lockfile.lock(process.argv[1], {realpath:false,lockfilePath:process.argv[1]+'.sync.lock',stale:300000,update:10000});
      process.stdout.write('locked');
      setInterval(()=>{},1000);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Lock child exited early'); })]);
      expect(String(ready[0])).toBe('locked');
      await expect(withSyncLock(path, async () => 'must not run')).rejects.toThrow('Another sync');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
    expect(await withSyncLock(path, async () => 'after exit')).toBe('after exit');
  });

  it('recovers a stale crashed-owner lock without leaving sync permanently blocked', async () => {
    const path = join(dir, 'config.json'), lock = path + '.sync.lock';
    await mkdir(lock);
    const old = new Date(Date.now() - 600000);
    await utimes(lock, old, old);
    expect(await withSyncLock(path, async () => 'recovered')).toBe('recovered');
  });
});
