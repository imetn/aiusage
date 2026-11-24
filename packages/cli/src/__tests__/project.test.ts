import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';
import { discoverProjects } from '../project.js';

const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn() }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => mockHomedir(),
}));

/** 向指定目录写入 JSONL 文件 */
async function writeJsonl(dir: string, filename: string, lines: object[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const content = lines.map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(dir, filename), content);
}

let tmpDir: string;
let origEnv: string | undefined;
let origKimiCodeHome: string | undefined;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-project-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  mockHomedir.mockReturnValue(tmpDir);
  origEnv = process.env.CLAUDE_CONFIG_DIR;
  origKimiCodeHome = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
});

afterEach(async () => {
  // 恢复环境变量
  if (origEnv === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = origEnv;
  }
  if (origKimiCodeHome === undefined) {
    delete process.env.KIMI_CODE_HOME;
  } else {
    process.env.KIMI_CODE_HOME = origKimiCodeHome;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Claude 项目发现 ───

describe('Claude 项目发现', () => {
  it('从 jsonl 的 cwd 字段提取项目名', async () => {
    // 设置 CLAUDE_CONFIG_DIR 指向临时目录，discoverClaudeProjects 会读 {dir}/projects/
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const projectDir = join(tmpDir, 'projects', 'Users-test-MyProject');
    // jsonl 含 cwd 字段
    await writeJsonl(projectDir, 'session.jsonl', [
      { cwd: '/Users/test/MyProject', type: 'summary', model: 'claude-sonnet' },
    ]);

    const results = await discoverProjects();
    const found = results.find((p) => p.name === 'MyProject');
    expect(found).toBeDefined();
    expect(found!.sources).toContain('claude');
  });

  it('发现多个不同项目', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;

    const projA = join(tmpDir, 'projects', 'Users-test-ProjectA');
    const projB = join(tmpDir, 'projects', 'Users-test-ProjectB');

    await writeJsonl(projA, 'session.jsonl', [
      { cwd: '/Users/test/ProjectA' },
    ]);
    await writeJsonl(projB, 'session.jsonl', [
      { cwd: '/home/dev/ProjectB' },
    ]);

    const results = await discoverProjects();
    const names = results.map((p) => p.name);
    expect(names).toContain('ProjectA');
    expect(names).toContain('ProjectB');
  });
});

// ─── 别名 ───

describe('别名应用', () => {
  it('projectAliases 正确映射到 alias 字段', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const projectDir = join(tmpDir, 'projects', 'encoded-path');
    await writeJsonl(projectDir, 'session.jsonl', [
      { cwd: '/Users/test/my-long-project-name' },
    ]);

    const aliases: Record<string, string> = {
      'my-long-project-name': '简称',
    };

    const results = await discoverProjects(aliases);
    const found = results.find((p) => p.name === 'my-long-project-name');
    expect(found).toBeDefined();
    expect(found!.alias).toBe('简称');
  });

  it('无别名时 alias 为 undefined', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const projectDir = join(tmpDir, 'projects', 'some-dir');
    await writeJsonl(projectDir, 'session.jsonl', [
      { cwd: '/Users/test/NoAlias' },
    ]);

    const results = await discoverProjects();
    const found = results.find((p) => p.name === 'NoAlias');
    expect(found).toBeDefined();
    expect(found!.alias).toBeUndefined();
  });
});

// ─── 空目录 ───

describe('空目录处理', () => {
  it('空 projects 目录返回结果中不含 Claude 项目', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    // 创建空的 projects 目录
    await mkdir(join(tmpDir, 'projects'), { recursive: true });

    const results = await discoverProjects();
    const claudeProjects = results.filter((p) => p.sources.includes('claude'));
    expect(claudeProjects).toHaveLength(0);
  });

  it('projects 目录不存在时不报错', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'nonexistent');
    // 不创建任何目录，调用不应抛异常
    const results = await discoverProjects();
    // 不一定是空（其他工具可能有项目），但至少不报错
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─── Kimi Code 项目发现 ───

describe('Kimi Code 项目发现', () => {
  it('从 session_index.jsonl 的 workDir 提取项目名', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    process.env.KIMI_CODE_HOME = join(tmpDir, '.kimi-code');
    await mkdir(process.env.KIMI_CODE_HOME, { recursive: true });
    await writeFile(
      join(process.env.KIMI_CODE_HOME, 'session_index.jsonl'),
      JSON.stringify({
        sessionId: 'session-1',
        sessionDir: join(process.env.KIMI_CODE_HOME, 'sessions', 'workspace', 'session-1'),
        workDir: '/Users/test/Projects/kimi-project',
      }),
    );

    const results = await discoverProjects();
    expect(results).toContainEqual(
      expect.objectContaining({
        name: 'kimi-project',
        sources: expect.arrayContaining(['kimi']),
      }),
    );
  });
});

// ─── 隐藏目录跳过 ───

describe('跳过隐藏目录', () => {
  it('跳过 . 开头的项目目录', async () => {
    process.env.CLAUDE_CONFIG_DIR = tmpDir;

    // 正常项目
    const normal = join(tmpDir, 'projects', 'VisibleProject');
    await writeJsonl(normal, 'session.jsonl', [
      { cwd: '/Users/test/VisibleProject' },
    ]);

    // 隐藏目录
    const hidden = join(tmpDir, 'projects', '.hidden-project');
    await writeJsonl(hidden, 'session.jsonl', [
      { cwd: '/Users/test/.hidden-project' },
    ]);

    const results = await discoverProjects();
    const names = results.map((p) => p.name);
    expect(names).toContain('VisibleProject');
    expect(names).not.toContain('.hidden-project');
  });
});

// ─── Codex 压缩会话项目发现 ───

describe('Codex 项目发现', () => {
  it('从 .jsonl.zst 压缩会话中提取项目名', async () => {
    const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
    if (typeof zstdCompressSync !== 'function') return;

    process.env.CLAUDE_CONFIG_DIR = join(tmpDir, 'empty-claude');
    const codexDir = join(tmpDir, '.codex', 'sessions', '2026', '05', '10');
    await mkdir(codexDir, { recursive: true });
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-10T12:00:00.000Z',
      payload: { id: 'sess-zst', cwd: '/Users/test/Projects/CompressedRepo' },
    }) + '\n', 'utf-8'));
    await writeFile(join(codexDir, 'rollout-2026-05-10.jsonl.zst'), compressed);

    const results = await discoverProjects();
    expect(results).toContainEqual(
      expect.objectContaining({
        name: 'CompressedRepo',
        sources: expect.arrayContaining(['codex']),
      }),
    );
  });
});
