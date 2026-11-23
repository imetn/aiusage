import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig, getConfigPath } from './config.js';
import { fetchHealth } from './api.js';
import { getScheduleStatus } from './schedule.js';
import { resolveKimiCodeHome } from './scanners/kimi.js';
import { resolveTraeNativeCacheDir, resolveTokscaleTraeCacheDir } from './scanners/trae.js';
import { detectOpenCodeSqliteRuntime, resolveOpenCodeSources } from './scanners/opencode.js';
import { discoverClaudeProjectDirs } from './scanners/claude.js';
import type { Lang } from './i18n.js';

export interface Check {
  group: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

const msgs = {
  en: {
    groupConfig: 'Configuration',
    groupSync: 'Sync Targets',
    groupTools: 'Tools',
    groupSchedule: 'Schedule',
    config: 'Config',
    configMissing: 'Not found, run aiusage init first',
    deviceId: 'Device ID',
    deviceIdMissing: 'Not configured, run aiusage init',
    targetMissing: 'Not configured, run aiusage enroll',
    targets: 'Targets',
    deviceToken: 'Device',
    tokenMissing: 'Not registered',
    server: 'Server',
    lastSync: 'Last sync',
    lastSyncNone: 'No record',
    notInstalled: 'Not installed',
    installedNoData: 'Installed, no usage data yet',
    hasData: (n: number) => `${n} session${n > 1 ? 's' : ''} found`,
    hasDataInDirs: (n: number, dirs: number) => `${n} session${n > 1 ? 's' : ''} found across ${dirs} data director${dirs === 1 ? 'y' : 'ies'}`,
    openCodeData: (dbs: number, legacy: number) => `${dbs} database(s), ${legacy} legacy message(s) found`,
    openCodeSqliteUnavailable: 'Database found, but this Node version requires the system sqlite3 executable',
    schedule: 'Schedule',
    scheduleEvery: 'every',
    scheduleEnabled: 'Enabled',
    scheduleOff: 'Not enabled, run aiusage schedule on',
  },
  zh: {
    groupConfig: '基本配置',
    groupSync: '同步目标',
    groupTools: '工具检测',
    groupSchedule: '定时任务',
    config: '配置文件',
    configMissing: '未找到，请先执行 aiusage init',
    deviceId: '设备 ID',
    deviceIdMissing: '未配置，请执行 aiusage init',
    targetMissing: '未配置，请执行 aiusage enroll',
    targets: '上报目标',
    deviceToken: '注册令牌',
    tokenMissing: '未注册',
    server: '服务端',
    lastSync: '上次同步',
    lastSyncNone: '暂无记录',
    notInstalled: '未安装',
    installedNoData: '已安装，暂无使用数据',
    hasData: (n: number) => `发现 ${n} 个会话`,
    hasDataInDirs: (n: number, dirs: number) => `在 ${dirs} 个数据目录中发现 ${n} 个会话`,
    openCodeData: (dbs: number, legacy: number) => `发现 ${dbs} 个数据库、${legacy} 条旧版消息`,
    openCodeSqliteUnavailable: '已发现数据库，但当前 Node 版本需要安装系统 sqlite3 才能读取',
    schedule: '定时同步',
    scheduleEvery: '每',
    scheduleEnabled: '已启用',
    scheduleOff: '未启用，可执行 aiusage schedule on',
  },
} as const;

/** 递归统计目录下指定扩展名的文件数（含子目录），上限 cap */
async function countFiles(dir: string, exts: string[], cap = 1000): Promise<number> {
  let count = 0;
  const queue = [dir];
  while (queue.length > 0 && count < cap) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (count >= cap) break;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        queue.push(full);
      } else if (exts.some(ext => e.name.endsWith(ext))) {
        count++;
      }
    }
  }
  return count;
}

// 每个工具的数据目录、检测的文件扩展名
interface ToolDef {
  dirs: string[];
  label: string;
  exts: string[];
}

export async function runDoctor(lang: Lang = 'zh'): Promise<Check[]> {
  const s = msgs[lang];
  const checks: Check[] = [];
  const config = await readConfig();

  // 基本配置
  const g1 = s.groupConfig;
  const configPath = getConfigPath();
  try {
    await stat(configPath);
    checks.push({ group: g1, name: s.config, status: 'ok', message: configPath });
  } catch {
    checks.push({ group: g1, name: s.config, status: 'fail', message: s.configMissing });
  }

  if (config.deviceId) {
    checks.push({ group: g1, name: s.deviceId, status: 'ok', message: config.deviceId });
  } else {
    checks.push({ group: g1, name: s.deviceId, status: 'warn', message: s.deviceIdMissing });
  }

  // 同步目标
  const g2 = s.groupSync;
  const targets = config.targets ?? [];
  if (targets.length === 0) {
    checks.push({ group: g2, name: s.targets, status: 'warn', message: s.targetMissing });
  } else {
    for (const target of targets) {
      const prefix = `[${target.name}]`;

      if (target.deviceToken) {
        checks.push({ group: g2, name: `${prefix} ${s.deviceToken}`, status: 'ok', message: `${target.deviceToken.slice(0, 12)}…` });
      } else {
        checks.push({ group: g2, name: `${prefix} ${s.deviceToken}`, status: 'fail', message: s.tokenMissing });
      }

      try {
        const health = await fetchHealth(target.apiBaseUrl);
        checks.push({ group: g2, name: `${prefix} ${s.server}`, status: 'ok', message: health.siteId });
      } catch (err) {
        checks.push({ group: g2, name: `${prefix} ${s.server}`, status: 'fail', message: err instanceof Error ? err.message : String(err) });
      }

      if (target.lastSuccessfulUploadAt) {
        checks.push({ group: g2, name: `${prefix} ${s.lastSync}`, status: 'ok', message: target.lastSuccessfulUploadAt });
      } else {
        checks.push({ group: g2, name: `${prefix} ${s.lastSync}`, status: 'warn', message: s.lastSyncNone });
      }
    }
  }

  // 工具检测
  const g3 = s.groupTools;
  const home = homedir();
  const claudeProjectDirs = await discoverClaudeProjectDirs();
  const tools: ToolDef[] = [
    { dirs: claudeProjectDirs, label: 'Claude Code', exts: ['.jsonl'] },
    { dirs: [join(home, '.codex')], label: 'Codex CLI', exts: ['.jsonl'] },
    { dirs: [join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')], label: 'Cursor', exts: ['.vscdb'] },
    { dirs: [join(home, '.copilot', 'session-state'), join(home, '.copilot', 'otel')], label: 'Copilot CLI', exts: ['.jsonl'] },
    {
      dirs: [
        join(home, 'Library', 'Application Support', 'Code', 'logs'),
        join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      ],
      label: 'Copilot VS Code',
      exts: ['.log', '.json', '.jsonl'],
    },
    { dirs: [join(home, '.gemini', 'tmp')], label: 'Gemini CLI', exts: ['.json', '.jsonl'] },
    { dirs: ['antigravity', 'antigravity-cli', 'antigravity-ide'].map(dir => join(home, '.gemini', dir)), label: 'Antigravity', exts: ['.json', '.db', '.pb'] },
    { dirs: [join(home, '.qwen', 'projects'), join(home, '.qwen', 'tmp')], label: 'Qwen Code', exts: ['.jsonl'] },
    { dirs: [join(resolveKimiCodeHome(home), 'sessions')], label: 'Kimi Code', exts: ['.jsonl'] },
    { dirs: [join(home, '.kimi', 'sessions')], label: 'Kimi CLI (legacy)', exts: ['.jsonl'] },
    { dirs: [join(home, '.local', 'share', 'amp', 'threads')], label: 'Amp', exts: ['.json'] },
    { dirs: [join(home, '.factory', 'sessions')], label: 'Droid', exts: ['.settings.json'] },
    { dirs: [join(home, '.pi', 'agent', 'sessions'), join(home, '.omp', 'agent', 'sessions')], label: 'Pi / OMP', exts: ['.jsonl'] },
    { dirs: [resolveTraeNativeCacheDir(home), resolveTokscaleTraeCacheDir(home)], label: 'Trae', exts: ['.json'] },
  ];

  for (const tool of tools) {
    let installed = false;
    let installedDirs = 0;
    let n = 0;
    for (const dir of tool.dirs) {
      try {
        await stat(dir);
        installed = true;
        installedDirs++;
        n += await countFiles(dir, tool.exts);
      } catch {
        // 检查同一工具的其他兼容目录。
      }
    }
    if (!installed) {
      checks.push({ group: g3, name: tool.label, status: 'warn', message: s.notInstalled });
      continue;
    }
    if (n > 0) {
      checks.push({
        group: g3,
        name: tool.label,
        status: 'ok',
        message: tool.label === 'Claude Code' ? s.hasDataInDirs(n, installedDirs) : s.hasData(n),
      });
    } else {
      checks.push({ group: g3, name: tool.label, status: 'warn', message: s.installedNoData });
    }
  }

  const openCodeSources = await resolveOpenCodeSources({
    dbPaths: config.scanner?.opencodeDbPaths,
  });
  const openCodeLegacyCount = await countFiles(openCodeSources.legacyDir, ['.json']);
  let openCodeInstalled = openCodeSources.dbPaths.length > 0 || openCodeLegacyCount > 0;
  if (!openCodeInstalled) {
    try {
      await stat(openCodeSources.dataDir);
      openCodeInstalled = true;
    } catch {
      // No OpenCode data directory and no configured database.
    }
  }
  if (!openCodeInstalled) {
    checks.push({ group: g3, name: 'OpenCode', status: 'warn', message: s.notInstalled });
  } else if (openCodeSources.dbPaths.length === 0 && openCodeLegacyCount === 0) {
    checks.push({ group: g3, name: 'OpenCode', status: 'warn', message: s.installedNoData });
  } else if (
    openCodeSources.dbPaths.length > 0
    && await detectOpenCodeSqliteRuntime() === 'unavailable'
  ) {
    checks.push({
      group: g3,
      name: 'OpenCode',
      status: 'warn',
      message: s.openCodeSqliteUnavailable,
    });
  } else {
    checks.push({
      group: g3,
      name: 'OpenCode',
      status: 'ok',
      message: s.openCodeData(openCodeSources.dbPaths.length, openCodeLegacyCount),
    });
  }

  // 定时任务
  const g4 = s.groupSchedule;
  const schedule = await getScheduleStatus();
  if (schedule.enabled) {
    checks.push({
      group: g4,
      name: s.schedule,
      status: 'ok',
      message: schedule.intervalLabel ? `${s.scheduleEvery} ${schedule.intervalLabel}` : s.scheduleEnabled,
    });
  } else {
    checks.push({ group: g4, name: s.schedule, status: 'warn', message: s.scheduleOff });
  }

  return checks;
}
