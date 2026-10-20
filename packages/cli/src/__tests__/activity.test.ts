import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function writeJsonl(path: string, lines: object[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n'));
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-activity-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('buildActivityReport', () => {
  it('counts Codex function calls, agent calls, lifecycle events, and skill proxy signals', async () => {
    const codexDir = join(tmpDir, 'codex');
    const sessionFile = join(codexDir, 'sessions', '2026', '06', '24', 'rollout-test.jsonl');
    await writeJsonl(sessionFile, [
      { type: 'session_meta', timestamp: '2026-06-24T12:00:00.000Z', payload: { id: 'codex-session-1' } },
      { type: 'turn_context', timestamp: '2026-06-24T12:00:00.000Z', payload: { cwd: '/Users/test/AIUsage' } },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:00:30.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '帮我看一下 activity 指标' }],
        },
      },
      {
        type: 'event_msg',
        timestamp: '2026-06-24T12:00:30.000Z',
        payload: { type: 'user_message', message: '帮我看一下 activity 指标' },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:01:00.000Z',
        payload: {
          item: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call-1',
            arguments: JSON.stringify({ cmd: 'sed -n 1,20p /Users/test/.codex/skills/check/SKILL.md' }),
          },
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:01:00.000Z',
        payload: {
          item: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call-1',
            arguments: JSON.stringify({ cmd: 'sed -n 1,20p /Users/test/.codex/skills/check/SKILL.md' }),
          },
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:02:00.000Z',
        payload: { item: { type: 'function_call', name: 'spawn_agent', call_id: 'call-2', arguments: '{}' } },
      },
      {
        type: 'response_item',
        timestamp: '2026-06-24T12:03:00.000Z',
        payload: { item: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-3', arguments: '{}' } },
      },
      { type: 'event_msg', timestamp: '2026-06-24T12:04:00.000Z', payload: { type: 'context_compacted' } },
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('today', {
      dates: ['2026-06-24'],
      codexDir,
      claudeProjectsDirs: [join(tmpDir, 'missing-claude')],
      antigravityDir: join(tmpDir, 'missing-antigravity'),
    });

    expect(report.totals.exactCount).toBe(4);
    expect(report.totals.proxyCount).toBe(1);
    expect(report.totals.userMessageCount).toBe(1);
    expect(report.totals.sessionsScanned).toBe(1);
    expect(report.byKind.find(row => row.key === 'function_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'agent_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'custom_tool_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'compaction')?.count).toBe(1);
    expect(report.topSkills.find(row => row.label.startsWith('check '))?.proxyCount).toBe(1);
  });

  it('counts Claude Code tool, Skill, Agent, and task calls with tool_use id dedupe', async () => {
    const claudeProjects = join(tmpDir, 'claude', 'projects');
    const sessionFile = join(claudeProjects, '-Users-test-AIUsage', 'session-1.jsonl');
    await writeJsonl(sessionFile, [
      {
        type: 'user',
        timestamp: '2026-06-24T11:59:59.000Z',
        sessionId: 'claude-session-1',
        cwd: '/Users/test/AIUsage',
        uuid: 'user-1',
        message: {
          role: 'user',
          content: '帮我审计 CLI 指标',
        },
      },
      {
        type: 'user',
        timestamp: '2026-06-24T12:00:00.500Z',
        sessionId: 'claude-session-1',
        cwd: '/Users/test/AIUsage',
        uuid: 'tool-result-1',
        sourceToolAssistantUUID: 'assistant-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', id: 'tool-1' }],
        },
      },
      {
        type: 'user',
        timestamp: '2026-06-24T12:00:00.600Z',
        sessionId: 'claude-session-1',
        cwd: '/Users/test/AIUsage',
        uuid: 'meta-1',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /tmp/skill' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-24T12:00:00.000Z',
        sessionId: 'claude-session-1',
        cwd: '/Users/test/AIUsage',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } },
            { type: 'tool_use', id: 'tool-2', name: 'Skill', input: { skill: 'security-review' } },
            { type: 'tool_use', id: 'tool-3', name: 'Agent', input: { description: '审计 CLI 指标' } },
            { type: 'tool_use', id: 'tool-4', name: 'TaskUpdate', input: { tasks: [] } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-24T12:00:01.000Z',
        sessionId: 'claude-session-1',
        cwd: '/Users/test/AIUsage',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Skill', input: { skill: 'security-review' } },
          ],
        },
      },
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('today', {
      dates: ['2026-06-24'],
      codexDir: join(tmpDir, 'missing-codex'),
      claudeProjectsDirs: [claudeProjects],
      antigravityDir: join(tmpDir, 'missing-antigravity'),
    });

    expect(report.totals.exactCount).toBe(4);
    expect(report.totals.proxyCount).toBe(0);
    expect(report.totals.userMessageCount).toBe(1);
    expect(report.byKind.find(row => row.key === 'tool_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'skill_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'agent_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'task')?.count).toBe(1);
    expect(report.topSkills[0].label).toBe('security-review (anthropic/claude-code)');
    expect(report.topAgents[0].label).toBe('审计 CLI 指标 (anthropic/claude-code)');
  });

  it('counts Antigravity user inputs and tool calls without retaining content or args', async () => {
    const antigravityDir = join(tmpDir, 'antigravity');
    const transcript = join(antigravityDir, 'brain', 'session-a', '.system_generated', 'logs', 'transcript.jsonl');
    await writeJsonl(transcript, [
      { type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-24T12:00:00.000Z', content: 'private prompt' },
      {
        type: 'MODEL_RESPONSE', status: 'DONE', created_at: '2026-06-24T12:00:05.000Z',
        tool_calls: [
          { name: 'view_file', args: { path: '/private/file' } },
          { name: 'invoke_subagent', args: { task: 'private task' } },
        ],
      },
      { type: 'USER_INPUT', status: 'ERROR', created_at: '2026-06-24T12:01:00.000Z' },
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('today', {
      dates: ['2026-06-24'],
      codexDir: join(tmpDir, 'missing-codex'),
      claudeProjectsDirs: [join(tmpDir, 'missing-claude')],
      antigravityDir,
    });

    expect(report.totals.userMessageCount).toBe(1);
    expect(report.totals.exactCount).toBe(2);
    expect(report.totals.sessionsScanned).toBe(1);
    expect(report.byKind.find(row => row.key === 'tool_call')?.count).toBe(1);
    expect(report.byKind.find(row => row.key === 'agent_call')?.count).toBe(1);
    expect(report.topTools.find(row => row.label === 'view_file (google/antigravity)')?.count).toBe(1);
    expect(JSON.stringify(report.items)).not.toContain('private prompt');
    expect(JSON.stringify(report.items)).not.toContain('/private/file');
  });

  it('counts only human Claude Code prompts and their typed characters', async () => {
    const claudeProjects = join(tmpDir, 'claude', 'projects');
    const base = { sessionId: 's1', cwd: '/Users/test/AIUsage' };
    await writeJsonl(join(claudeProjects, '-Users-test-AIUsage', 's1.jsonl'), [
      {
        ...base, type: 'user', uuid: 'u1', timestamp: '2026-06-24T12:00:00.000Z', origin: { kind: 'human' },
        message: {
          role: 'user',
          content: '改一下 status line<system-reminder>ignored</system-reminder><pasted_content id="1">粘贴的内容</pasted_content>',
        },
      },
      {
        ...base, type: 'user', uuid: 'u2', timestamp: '2026-06-24T12:01:00.000Z', origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification>done</task-notification>' },
      },
      {
        ...base, type: 'user', uuid: 'u3', timestamp: '2026-06-24T12:02:00.000Z', isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation' },
      },
      {
        ...base, type: 'user', uuid: 'u4', timestamp: '2026-06-24T12:03:00.000Z', origin: { kind: 'human' },
        message: { role: 'user', content: '<scheduled-task name="daily">automated run</scheduled-task>' },
      },
      {
        ...base, type: 'attachment', uuid: 'a1', timestamp: '2026-06-24T12:04:00.000Z',
        attachment: { type: 'queued_command', prompt: 'hi you', origin: { kind: 'human' }, source_uuid: 'q1' },
      },
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('today', {
      dates: ['2026-06-24'],
      codexDir: join(tmpDir, 'missing-codex'),
      claudeProjectsDirs: [claudeProjects],
      antigravityDir: join(tmpDir, 'missing-antigravity'),
    });

    expect(report.totals.userMessageCount).toBe(2);
    // "改一下statusline" = 13, "hiyou" = 5; pasted block excluded
    expect(report.totals.userMessageChars).toBe(18);
    expect(report.daily[0].userMessageChars).toBe(18);
  });

  it('extracts typed Codex text and skips automated sessions', async () => {
    const codexDir = join(tmpDir, 'codex');
    await writeJsonl(join(codexDir, 'sessions', '2026', '06', '24', 'rollout-a.jsonl'), [
      { type: 'session_meta', timestamp: '2026-06-24T12:00:00.000Z', payload: { id: 'a', originator: 'Codex Desktop', source: 'vscode' } },
      {
        type: 'response_item', timestamp: '2026-06-24T12:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] },
      },
      {
        type: 'event_msg', timestamp: '2026-06-24T12:00:02.000Z',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: '# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\n看看这张图' }] },
        },
      },
      {
        type: 'event_msg', timestamp: '2026-06-24T12:00:03.000Z',
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: '<heartbeat>tick</heartbeat>' }] } },
      },
    ]);
    await writeJsonl(join(codexDir, 'sessions', '2026', '06', '24', 'rollout-b.jsonl'), [
      { type: 'session_meta', timestamp: '2026-06-24T12:00:00.000Z', payload: { id: 'b', source: { subagent: { other: 'guardian' } } } },
      { type: 'event_msg', timestamp: '2026-06-24T12:00:01.000Z', payload: { type: 'user_message', message: 'The following is the Codex agent history' } },
    ]);

    const { buildActivityReport } = await import('../activity.js');
    const report = await buildActivityReport('today', {
      dates: ['2026-06-24'],
      codexDir,
      claudeProjectsDirs: [join(tmpDir, 'missing-claude')],
      antigravityDir: join(tmpDir, 'missing-antigravity'),
    });

    expect(report.totals.userMessageCount).toBe(1);
    expect(report.totals.userMessageChars).toBe(5);
  });
});
