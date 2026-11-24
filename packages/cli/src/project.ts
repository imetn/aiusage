import { open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { discoverAntigravityProjects as discoverAntigravityDatabaseProjects } from './scanners/antigravity.js';
import { collectCodexSessionFiles, openCodexLineStream } from './scanners/codex.js';
import { discoverGrokProjects } from './scanners/grok.js';
import { resolveKimiCodeHome } from './scanners/kimi.js';
import { resolveTraeNativeCacheDir } from './scanners/trae.js';

export interface DiscoveredProject {
  /** 原始项目名（目录 basename） */
  name: string;
  /** 已设置的别名，无则为 undefined */
  alias?: string;
  /** 发现该项目的工具来源 */
  sources: string[];
}

/**
 * 扫描所有支持工具的数据目录，发现本机全部项目。
 * 仅读目录结构，不解析日志，速度快。
 */
export async function discoverProjects(
  projectAliases?: Record<string, string>,
): Promise<DiscoveredProject[]> {
  const projectMap = new Map<string, Set<string>>(); // name → sources

  function add(name: string, source: string) {
    if (!name || name === 'unknown') return;
    if (!projectMap.has(name)) projectMap.set(name, new Set());
    projectMap.get(name)!.add(source);
  }

  await Promise.all([
    // Claude: ~/.claude/projects/{encoded-path}/
    // 目录名是编码路径（- 替换 /），但项目名本身可能含 -，无法可靠还原。
    // 读取每个项目目录下第一个 jsonl 首行的 cwd 字段来获取真实项目名。
    discoverClaudeProjects().then(names => names.forEach(n => add(n, 'claude'))),

    // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
    // 每个 session 首行 session_meta 含 cwd 字段
    discoverCodexProjects().then(names => names.forEach(n => add(n, 'codex'))),

    // Copilot CLI: ~/.copilot/session-state/{sessionId}/events.jsonl
    // 首行 session.start 含 data.context.gitRoot / cwd
    discoverCopilotProjects().then(names => names.forEach(n => add(n, 'copilot'))),

    // Cursor: ~/Library/Application Support/Cursor/User/globalStorage/storage.json
    // 读取 workspace/profile 关联记录来发现近期项目
    discoverCursorProjects().then(names => names.forEach(n => add(n, 'cursor'))),

    // Copilot VS Code: VS Code 扩展日志中的 file:/// 工作区路径
    discoverCopilotVscodeProjects().then(names => names.forEach(n => add(n, 'copilot-vscode'))),

    // Gemini CLI: ~/.gemini/projects.json 含 { projects: { path: name } }
    discoverGeminiProjects().then(names => names.forEach(n => add(n, 'gemini'))),

    // Antigravity: ~/.gemini/antigravity/knowledge/*/metadata.json
    // 仅读取知识项元数据标题，不读取对话内容
    discoverAntigravityProjects().then(names => names.forEach(n => add(n, 'antigravity'))),

    // Grok CLI: ~/.grok/sessions/{encoded-path}/
    discoverGrokProjects().then(names => names.forEach(n => add(n, 'grok'))),

    // Kimi CLI / Kimi Code: legacy workspace map + new session metadata.
    discoverKimiProjects().then(names => names.forEach(n => add(n, 'kimi'))),

    // Trae CN: privacy-minimized cache written by `aiusage trae sync`.
    discoverTraeProjects().then(names => names.forEach(n => add(n, 'trae'))),
  ]);

  // ���建结果
  const results: DiscoveredProject[] = [];
  for (const [name, sources] of projectMap) {
    const alias = projectAliases?.[name];
    results.push({
      name,
      alias,
      sources: [...sources].sort(),
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 Claude 项目目录中读取 jsonl 首行的 cwd 来获取真实项目名 */
async function discoverClaudeProjects(): Promise<string[]> {
  const names: string[] = [];
  for (const baseDir of getClaudeDirs()) {
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const projectDir = join(baseDir, entry.name);
      const name = await extractCwdFromFirstJsonl(projectDir);
      if (name && name !== 'unknown') names.push(name);
    }
  }
  return names;
}

/** 从 Codex session 文件（含 .jsonl 与 .jsonl.zst、sessions 与 archived_sessions）中提取所有不同的项目名 */
async function discoverCodexProjects(): Promise<string[]> {
  const files = await collectCodexSessionFiles(join(homedir(), '.codex'));
  const projects = new Set<string>();

  for (const filePath of files) {
    const name = await extractCwdFromSessionMeta(filePath);
    if (name && name !== 'unknown') projects.add(name);
  }
  return [...projects];
}

/** 读取 Codex session 首行的 session_meta.payload.cwd（支持 .jsonl 与 .jsonl.zst） */
async function extractCwdFromSessionMeta(filePath: string): Promise<string | undefined> {
  if (filePath.endsWith('.jsonl.zst')) {
    const opened = openCodexLineStream(filePath);
    if (!opened) return undefined;
    try {
      const rl = createInterface({ input: opened.lineInput, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        const record = JSON.parse(line);
        const cwd: string | undefined = record?.payload?.cwd;
        if (!cwd) return undefined;
        const parts = cwd.split('/').filter(Boolean);
        return parts[parts.length - 1] || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      opened.cleanup();
    }
  }

  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const line = buf.subarray(0, bytesRead).toString('utf-8').split('\n')[0];
    const record = JSON.parse(line);
    const cwd: string | undefined = record?.payload?.cwd;
    if (!cwd) return undefined;
    const parts = cwd.split('/').filter(Boolean);
    return parts[parts.length - 1] || undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** 递归查找目录下所有 .jsonl 文件 */
async function walkJsonlFiles(dir: string): Promise<string[]> {
  return walkFiles(dir, '.jsonl');
}

async function walkFiles(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(ext)) result.push(full);
    }
  }
  await walk(dir);
  return result;
}

/**
 * 找到项目目录下的第一个 .jsonl 文件（顶层或子目录），
 * 读取前 32KB 内容，扫描各行找到含 cwd 字段的记录，提取 basename。
 */
async function extractCwdFromFirstJsonl(dir: string): Promise<string | undefined> {
  const jsonlPath = await findFirstJsonl(dir);
  if (!jsonlPath) return undefined;

  let fh;
  try {
    fh = await open(jsonlPath, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.cwd) {
          const parts = record.cwd.split('/').filter(Boolean);
          const name = parts[parts.length - 1];
          if (name) return name;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** 在目录中查找第一个 .jsonl 文件，先查顶层，再查一层子目录 */
async function findFirstJsonl(dir: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // 顶层 jsonl
  const topJsonl = entries.find(e => e.isFile() && e.name.endsWith('.jsonl'));
  if (topJsonl) return join(dir, topJsonl.name);
  // 一层子目录
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const subFiles = await readdir(join(dir, entry.name));
      const sub = subFiles.find(f => f.endsWith('.jsonl'));
      if (sub) return join(dir, entry.name, sub);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 从 Copilot session events 首行提取项目名 */
async function discoverCopilotProjects(): Promise<string[]> {
  const dir = join(homedir(), '.copilot', 'session-state');
  const files = await walkJsonlFiles(dir);
  const projects = new Set<string>();

  for (const filePath of files) {
    let fh;
    try {
      fh = await open(filePath, 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead === 0) continue;
      const line = buf.subarray(0, bytesRead).toString('utf-8').split('\n')[0];
      const record = JSON.parse(line);
      const raw: string | undefined = record?.data?.context?.gitRoot ?? record?.data?.context?.cwd;
      if (raw) {
        const parts = raw.split('/').filter(Boolean);
        const name = parts[parts.length - 1];
        if (name && name !== 'unknown') projects.add(name);
      }
    } catch {
      continue;
    } finally {
      await fh?.close();
    }
  }
  return [...projects];
}

/** 从 Gemini projects.json 读取项目列表 */
async function discoverGeminiProjects(): Promise<string[]> {
  const filePath = join(homedir(), '.gemini', 'projects.json');
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const projects: Record<string, string> | undefined = data?.projects;
    if (!projects || typeof projects !== 'object') return [];
    const names: string[] = [];
    for (const [path, _name] of Object.entries(projects)) {
      const parts = path.split('/').filter(Boolean);
      const name = parts[parts.length - 1];
      if (name && name !== 'unknown') names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

async function discoverCursorProjects(): Promise<string[]> {
  const storagePath = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json');
  try {
    const raw = await readFile(storagePath, 'utf-8');
    const data = JSON.parse(raw) as {
      profileAssociations?: { workspaces?: Record<string, string> };
      backupWorkspaces?: { folders?: Array<{ folderUri?: string }> };
    };

    const projects = new Set<string>();
    const workspaceUris = Object.keys(data.profileAssociations?.workspaces ?? {});
    for (const uri of workspaceUris) {
      const name = nameFromFileUri(uri);
      if (name) projects.add(name);
    }

    for (const folder of data.backupWorkspaces?.folders ?? []) {
      const name = nameFromFileUri(folder.folderUri);
      if (name) projects.add(name);
    }

    return [...projects];
  } catch {
    return [];
  }
}

async function discoverCopilotVscodeProjects(): Promise<string[]> {
  const dir = join(homedir(), 'Library', 'Application Support', 'Code', 'logs');
  const files = (await walkFiles(dir, '.log')).filter(filePath => filePath.endsWith('GitHub Copilot Chat.log'));
  const projects = new Set<string>();

  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    for (const line of content.split('\n')) {
      const match = line.match(/file:\/\/\/[^\s]+/);
      const name = nameFromFileUri(match?.[0]);
      if (name) projects.add(name);
    }
  }

  return [...projects];
}

async function discoverAntigravityProjects(): Promise<string[]> {
  const databaseProjects = await discoverAntigravityDatabaseProjects();
  const dir = join(homedir(), '.gemini', 'antigravity', 'knowledge');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return databaseProjects;
  }

  const projects = new Set<string>(databaseProjects);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = join(dir, entry.name, 'metadata.json');
    try {
      const raw = await readFile(metadataPath, 'utf-8');
      const data = JSON.parse(raw) as { title?: string };
      const name = data.title?.trim() || entry.name.trim();
      if (name && name !== 'unknown') projects.add(name);
    } catch {
      continue;
    }
  }

  return [...projects];
}

async function discoverKimiProjects(): Promise<string[]> {
  const projects = new Set<string>();
  const home = homedir();

  try {
    const raw = await readFile(join(home, '.kimi', 'kimi.json'), 'utf-8');
    const data = JSON.parse(raw) as { workspaces?: Record<string, { path?: string }> };
    for (const workspace of Object.values(data.workspaces ?? {})) {
      const name = basename(workspace.path?.trim() ?? '');
      if (name && name !== 'unknown') projects.add(name);
    }
  } catch {
    // Legacy Kimi config is optional.
  }

  const codeHome = resolveKimiCodeHome(home);
  try {
    const raw = await readFile(join(codeHome, 'session_index.jsonl'), 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { workDir?: string };
        const name = basename(record.workDir?.trim() ?? '');
        if (name && name !== 'unknown') projects.add(name);
      } catch {
        continue;
      }
    }
  } catch {
    // Fall through to per-session state files.
  }

  const stateFiles = (await walkFiles(join(codeHome, 'sessions'), '.json'))
    .filter(filePath => basename(filePath) === 'state.json');
  for (const filePath of stateFiles) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const state = JSON.parse(raw) as { workDir?: string };
      const name = basename(state.workDir?.trim() ?? '');
      if (name && name !== 'unknown') projects.add(name);
    } catch {
      continue;
    }
  }

  return [...projects];
}

async function discoverTraeProjects(): Promise<string[]> {
  const projects = new Set<string>();
  for (const filePath of await walkFiles(resolveTraeNativeCacheDir(), '.json')) {
    try {
      const data = JSON.parse(await readFile(filePath, 'utf8')) as { project?: string };
      const name = basename(data.project?.trim() ?? '');
      if (name && name !== 'unknown') projects.add(name);
    } catch {
      continue;
    }
  }
  return [...projects];
}

function nameFromFileUri(raw?: string): string | undefined {
  const path = pathFromFileUri(raw);
  if (!path) return undefined;
  const name = basename(path);
  return name && name !== 'unknown' ? name : undefined;
}

function pathFromFileUri(raw?: string): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('file:///')) {
    const cleaned = raw.replace(/[.).,;:]+$/, '');
    try {
      return decodeURIComponent(cleaned.replace(/^file:\/\//, ''));
    } catch {
      return cleaned.replace(/^file:\/\//, '');
    }
  }
  return raw;
}

function getClaudeDirs(): string[] {
  const envVar = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envVar) {
    return envVar.split(',').map(p => p.trim()).filter(Boolean).map(p => join(p, 'projects'));
  }
  const home = homedir();
  return [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ];
}
