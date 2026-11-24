import type { ChartConfig } from './components/ui/chart';

export const TOKEN_SERIES = [
  { key: 'inputTokens' as const, label: 'Input', color: '#0f172a', darkColor: '#888888' },
  { key: 'cachedInputTokens' as const, label: 'Cached', color: '#334155', darkColor: '#6e6e6e' },
  { key: 'cacheWriteTokens' as const, label: 'Cache Write', color: '#64748b', darkColor: '#555555' },
  { key: 'outputTokens' as const, label: 'Output', color: '#94a3b8', darkColor: '#444444' },
  { key: 'reasoningOutputTokens' as const, label: 'Reasoning', color: '#cbd5e1', darkColor: '#2a2a2a' },
];

export const CHART_COLORS = [
  '#0f172a', '#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0',
];

export const CHART_COLORS_DARK = [
  '#888888', '#6e6e6e', '#555555', '#444444', '#363636', '#2a2a2a', '#1f1f1f',
];

export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#0f172a',
  openai: '#1e293b',
  google: '#334155',
  github: '#475569',
  sourcegraph: '#64748b',
  moonshot: '#94a3b8',
  alibaba: '#cbd5e1',
  droid: '#e2e8f0',
  opencode: '#f1f5f9',
  trae: '#7c3aed',
  zhipu: '#2563eb',
  xai: '#18181b',
};

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  github: 'GitHub',
  sourcegraph: 'Sourcegraph',
  moonshot: 'Kimi / Moonshot',
  alibaba: 'Alibaba',
  droid: 'Droid',
  opencode: 'OpenCode',
  trae: 'Trae',
  zhipu: 'Zhipu AI',
  xai: 'xAI',
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

export const TOKEN_CONFIG = Object.fromEntries(
  TOKEN_SERIES.map((s) => [s.key, { label: s.label, color: s.color }]),
) satisfies ChartConfig;

export const TOKEN_CONFIG_DARK = Object.fromEntries(
  TOKEN_SERIES.map((s) => [s.key, { label: s.label, color: s.darkColor }]),
) satisfies ChartConfig;

export function getChartColors(isDark: boolean) {
  return isDark ? CHART_COLORS_DARK : CHART_COLORS;
}

export function getTokenConfig(isDark: boolean) {
  return isDark ? TOKEN_CONFIG_DARK : TOKEN_CONFIG;
}

export function getTokenColor(s: typeof TOKEN_SERIES[number], isDark: boolean) {
  return isDark ? s.darkColor : s.color;
}

export function formatProductLabel(raw: string): string {
  const labels: Record<string, string> = {
    trae: 'Trae (All)',
    'trae-cn': 'Trae CN',
    'trae-intl': 'Trae International',
  };
  if (labels[raw]) return labels[raw];
  return raw
    .split('-')
    .map((w) => (w === 'cli' ? 'CLI' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
