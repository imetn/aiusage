import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const LABEL = 'com.aiusage.sync';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH = join(homedir(), '.aiusage', 'sync.log');
const CRON_MARKER = '# aiusage-sync';

export interface ScheduleStatus {
  enabled: boolean;
  interval?: number;
  intervalLabel?: string;
  path?: string;
  command?: string;
  logPath?: string;
  includeToday?: boolean;
}

export function parseInterval(value: string): { seconds: number; label: string } {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error('--every 格式错误，示例: 30m, 1h, 2h, 1d');
  const num = parseInt(match[1], 10);
  const unit = match[2];
  let seconds: number;
  switch (unit) {
    case 'm': seconds = num * 60; break;
    case 'h': seconds = num * 3600; break;
    case 'd': seconds = num * 86400; break;
    default: throw new Error('不支持的时间单位');
  }
  if (seconds < 300) throw new Error('间隔不能少于 5 分钟');
  if (seconds > 86400) throw new Error('间隔不能超过 1 天');
  return { seconds, label: value };
}

export function formatInterval(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export async function enableSchedule(intervalSeconds: number): Promise<ScheduleStatus> {
  return platform() === 'darwin'
    ? enableLaunchd(intervalSeconds)
    : enableCron(intervalSeconds);
}

export async function disableSchedule(): Promise<void> {
  return platform() === 'darwin' ? disableLaunchd() : disableCron();
}

export async function getScheduleStatus(): Promise<ScheduleStatus> {
  return platform() === 'darwin' ? getLaunchdStatus() : getCronStatus();
}

// ── resolve paths ──

export function resolveScheduledNodePath(execPath = process.execPath): string {
  // Node resolves executable symlinks, so process.execPath pins a Homebrew
  // Cellar version that can disappear on upgrade. Keep a matching stable link.
  const homebrew = execPath.match(/^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/);
  if (!homebrew) return execPath;

  const [, prefix, formula] = homebrew;
  for (const candidate of [join(prefix, 'bin', 'node'), join(prefix, 'opt', formula, 'bin', 'node')]) {
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === execPath) return candidate;
    } catch { /* Missing or unusable link; try the next stable path. */ }
  }
  return execPath;
}

export function resolveCommandPaths(): { nodePath: string; scriptPath: string } {
  const entryPath = process.argv[1];
  if (!entryPath) throw new Error('无法解析当前 aiusage 命令路径');
  const scriptPath = realpathSync(resolve(entryPath));
  if (scriptPath.includes('_npx') || scriptPath.includes('/npx-')) {
    throw new Error(
      '检测到通过 npx 运行，定时任务需要全局安装。\n请先执行: npm install -g @aiusage/cli',
    );
  }
  return { nodePath: resolveScheduledNodePath(), scriptPath };
}

// ── macOS launchd ──

async function enableLaunchd(intervalSeconds: number): Promise<ScheduleStatus> {
  const { nodePath, scriptPath } = resolveCommandPaths();
  await mkdir(join(homedir(), '.aiusage'), { recursive: true });

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(nodePath)}</string>`,
    `    <string>${escapeXml(scriptPath)}</string>`,
    '    <string>sync</string>',
    '    <string>--today</string>',
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${intervalSeconds}</integer>`,
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(LOG_PATH)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(LOG_PATH)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  try { await execFileAsync('launchctl', ['unload', PLIST_PATH]); } catch { /* ok */ }
  await writeFile(PLIST_PATH, plist, 'utf-8');
  await execFileAsync('launchctl', ['load', PLIST_PATH]);

  return {
    enabled: true,
    interval: intervalSeconds,
    intervalLabel: formatInterval(intervalSeconds),
    path: PLIST_PATH,
  };
}

async function disableLaunchd(): Promise<void> {
  try { await execFileAsync('launchctl', ['unload', PLIST_PATH]); } catch { /* ok */ }
  try { await unlink(PLIST_PATH); } catch { /* ok */ }
}

async function getLaunchdStatus(): Promise<ScheduleStatus> {
  try {
    await stat(PLIST_PATH);
  } catch {
    return { enabled: false };
  }
  try {
    const content = await readFile(PLIST_PATH, 'utf-8');
    const match = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    const interval = match ? parseInt(match[1], 10) : undefined;
    // 提取 ProgramArguments 中的命令
    const argMatches = [...content.matchAll(/<string>([^<]+)<\/string>/g)].map(m => m[1]);
    const command = argMatches.length > 0 ? argMatches.join(' ') : undefined;
    const includeToday = content.includes('--today');
    // 提取日志路径
    const logMatch = content.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);
    const logPath = logMatch?.[1];
    return {
      enabled: true,
      interval,
      intervalLabel: interval ? formatInterval(interval) : undefined,
      path: PLIST_PATH,
      command,
      logPath,
      includeToday,
    };
  } catch {
    return { enabled: false };
  }
}

// ── Linux cron ──

async function enableCron(intervalSeconds: number): Promise<ScheduleStatus> {
  const { nodePath, scriptPath } = resolveCommandPaths();
  const cronExpr = secondsToCron(intervalSeconds);
  const logPath = join(homedir(), '.aiusage', 'sync.log');
  const cronLine = `${cronExpr} ${nodePath} ${scriptPath} sync --today >> ${logPath} 2>&1 ${CRON_MARKER}`;

  await mkdir(join(homedir(), '.aiusage'), { recursive: true });

  let existing = '';
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    existing = stdout;
  } catch { /* no crontab */ }

  const filtered = existing
    .split('\n')
    .filter((line) => !line.includes(CRON_MARKER))
    .join('\n')
    .trimEnd();

  const newContent = filtered ? `${filtered}\n${cronLine}\n` : `${cronLine}\n`;
  await writeCrontab(newContent);

  return {
    enabled: true,
    interval: intervalSeconds,
    intervalLabel: formatInterval(intervalSeconds),
  };
}

async function disableCron(): Promise<void> {
  let existing = '';
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    existing = stdout;
  } catch { return; }

  const filtered = existing
    .split('\n')
    .filter((line) => !line.includes(CRON_MARKER))
    .join('\n')
    .trimEnd();

  if (!filtered) {
    try { await execFileAsync('crontab', ['-r']); } catch { /* ok */ }
  } else {
    await writeCrontab(filtered + '\n');
  }
}

async function getCronStatus(): Promise<ScheduleStatus> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    const line = stdout.split('\n').find((l) => l.includes(CRON_MARKER));
    if (!line) return { enabled: false };
    const interval = cronToSeconds(line);
    const includeToday = line.includes('--today');
    // cron 行格式: */5 * * * * /path/to/node /path/to/aiusage sync --today >> /log 2>&1 # marker
    const logMatch = line.match(/>>\s*(\S+)/);
    const logPath = logMatch?.[1];
    // 提取 cron 表达式后的命令部分
    const cmdMatch = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+?)(?:\s*>>)/);
    const command = cmdMatch?.[1];
    return {
      enabled: true,
      interval,
      intervalLabel: interval ? formatInterval(interval) : undefined,
      command,
      logPath,
      includeToday,
    };
  } catch {
    return { enabled: false };
  }
}

async function writeCrontab(content: string): Promise<void> {
  const tmpFile = join(tmpdir(), `aiusage-cron-${Date.now()}`);
  await writeFile(tmpFile, content, 'utf-8');
  try {
    await execFileAsync('crontab', [tmpFile]);
  } finally {
    try { await unlink(tmpFile); } catch { /* ok */ }
  }
}

function secondsToCron(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes <= 60) return `*/${minutes} * * * *`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `0 */${hours} * * *`;
  return '10 0 * * *';
}

function cronToSeconds(cronLine: string): number | undefined {
  const parts = cronLine.trim().split(/\s+/);
  if (parts.length < 5) return undefined;
  const [minute, hour] = parts;
  const minMatch = minute.match(/^\*\/(\d+)$/);
  if (minMatch) return parseInt(minMatch[1], 10) * 60;
  const hourMatch = hour.match(/^\*\/(\d+)$/);
  if (hourMatch && minute === '0') return parseInt(hourMatch[1], 10) * 3600;
  if (minute === '10' && hour === '0') return 86400;
  return undefined;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
