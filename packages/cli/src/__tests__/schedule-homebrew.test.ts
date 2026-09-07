import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCommandPaths, resolveScheduledNodePath } from '../schedule.js';

let prefix: string;

beforeEach(async () => {
  prefix = await realpath(await mkdtemp(join(tmpdir(), 'aiusage-schedule-')));
});

afterEach(async () => {
  await rm(prefix, { recursive: true, force: true });
});

async function makeNode(formula = 'node', version = '23.7.0'): Promise<string> {
  const path = join(prefix, 'Cellar', formula, version, 'bin', 'node');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

async function linkNode(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

describe('scheduled Node executable', () => {
  it('uses the stable Node link while still resolving volatile CLI shims', async () => {
    const node = await makeNode();
    const stableNode = join(prefix, 'bin', 'node');
    await linkNode(node, stableNode);
    const script = join(prefix, 'package', 'cli.js');
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, '#!/usr/bin/env node\n');
    const shim = join(prefix, 'fnm_multishells', '1234', 'bin', 'aiusage');
    await linkNode(script, shim);

    const originalArgv = process.argv;
    const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
    process.argv = [node, shim];
    Object.defineProperty(process, 'execPath', { ...originalExecPath, value: node });
    try {
      expect(resolveCommandPaths()).toEqual({ nodePath: stableNode, scriptPath: script });
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process, 'execPath', originalExecPath);
    }
  });

  it('keeps the scheduled path usable after Homebrew upgrades and removes the old version', async () => {
    const oldNode = await makeNode();
    const stable = join(prefix, 'bin', 'node');
    await linkNode(oldNode, stable);
    const scheduled = await resolveScheduledNodePath(oldNode);
    expect(scheduled).toBe(stable);

    const newNode = await makeNode('node', '25.9.0_1');
    await unlink(stable);
    await linkNode(newNode, stable);
    await rm(join(prefix, 'Cellar', 'node', '23.7.0'), { recursive: true });
    await expect(access(scheduled, constants.X_OK)).resolves.toBeUndefined();
    expect(await realpath(scheduled)).toBe(newNode);
  });

  it('uses the formula opt link when the global node belongs to a different runtime', async () => {
    const node = await makeNode('node@22', '22.16.0');
    const otherNode = await makeNode();
    await linkNode(otherNode, join(prefix, 'bin', 'node'));
    const stable = join(prefix, 'opt', 'node@22', 'bin', 'node');
    await linkNode(node, stable);
    expect(await resolveScheduledNodePath(node)).toBe(stable);
  });

  it('falls back to the current executable when stable links are absent or broken', async () => {
    const node = await makeNode();
    expect(await resolveScheduledNodePath(node)).toBe(node);
    await linkNode(join(prefix, 'missing-node'), join(prefix, 'bin', 'node'));
    expect(await resolveScheduledNodePath(node)).toBe(node);
  });

  it('does not silently switch to a different installed Node', async () => {
    const node = await makeNode();
    await linkNode(await makeNode('node', '25.9.0_1'), join(prefix, 'bin', 'node'));
    expect(await resolveScheduledNodePath(node)).toBe(node);
  });

  it('preserves non-Homebrew installations', async () => {
    const node = join(prefix, '.nvm', 'versions', 'node', 'v22.16.0', 'bin', 'node');
    expect(await resolveScheduledNodePath(node)).toBe(node);
  });
});
