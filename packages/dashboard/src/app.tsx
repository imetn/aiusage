import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  RotateCw, Github, Heart, Sun, Moon, Monitor,
  ChevronDown, Check, BrainCircuit,
} from 'lucide-react';
import type { Locale, T } from './i18n';
import { I18N, getStoredLocale } from './i18n';
import type { ThemeMode } from './theme';
import { getStoredTheme, applyTheme } from './theme';
import { TOKEN_SERIES, getChartColors, getTokenColor, providerLabel, formatProductLabel } from './constants';
import { useIsDark } from './hooks/use-dark';
import {
  formatUsd, formatUsdFull, formatCompact, formatNumber, formatPercent,
  formatModelName, shortDate, longDate, arrSum, foldItems,
} from './utils/format';
import type { FiltersState, FacetOption } from './hooks/use-overview';
import { useOverview } from './hooks/use-overview';
import { ChartBoundary, EmptyState, Skeleton, SectionHeader, ChartLegend } from './components/chart-helpers';
import { KpiCard, CostKpiCard } from './components/kpi-card';
import { useFetchCnyRate, useCurrencyStore } from './hooks/use-cny-rate';
import { CostTrendChart } from './components/cost-trend-chart';
import { TokenTrendChart } from './components/token-trend-chart';
import { PromptTrendChart } from './components/prompt-trend-chart';
import { TokenCompositionChart } from './components/token-composition-chart';
import { FlowChart } from './components/flow-chart';
import { DonutSection } from './components/donut-section';
import { ActivityHeatmap } from './components/activity-heatmap';
import { buildActivityHeatmapData } from './utils/activity-heatmap-data';
import { HeaderLogo, FooterLogo, useFaviconFromLogo } from './components/site-logo';
import { SITE_TITLE } from './site-config';
import codexIcon from '@lobehub/icons-static-svg/icons/codex-color.svg?url';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg?url';
import claudeIcon from '@lobehub/icons-static-svg/icons/claude-color.svg?url';
import anthropicIcon from '@lobehub/icons-static-svg/icons/anthropic.svg?url';
import deepseekIcon from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import openaiIcon from '@lobehub/icons-static-svg/icons/openai.svg?url';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import geminiCliIcon from '@lobehub/icons-static-svg/icons/geminicli-color.svg?url';
import glmvIcon from '@lobehub/icons-static-svg/icons/glmv-color.svg?url';
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi.svg?url';
import copilotIcon from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url';
import traeIcon from '@lobehub/icons-static-svg/icons/trae-color.svg?url';
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg?url';
import openrouterIcon from '@lobehub/icons-static-svg/icons/openrouter-color.svg?url';
import antigravityIcon from '@lobehub/icons-static-svg/icons/antigravity-color.svg?url';
import ampIcon from '@lobehub/icons-static-svg/icons/amp-color.svg?url';
import cursorIcon from '@lobehub/icons-static-svg/icons/cursor.svg?url';
import opencodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import moonshotIcon from '@lobehub/icons-static-svg/icons/moonshot.svg?url';

// ────────────────────────────────────────
// Constants
// ────────────────────────────────────────

function getRanges(t: T) {
  return [
    { value: 'all', label: t.all },
    { value: '7d', label: t.range7d },
    { value: '30d', label: t.range30d },
    { value: '90d', label: t.range90d },
    { value: 'month', label: t.thisMonth },
  ] as const;
}

function formatDeltaPercent(current?: number | null, previous?: number | null): string | undefined {
  const currentValue = Number(current ?? 0);
  const previousValue = Number(previous ?? 0);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue <= 0) return undefined;
  const delta = ((currentValue - previousValue) / previousValue) * 100;
  if (!Number.isFinite(delta)) return undefined;
  const normalized = Math.abs(delta) < 0.05 ? 0 : delta;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(1)}%`;
}

type FilterIconAsset = {
  src: string;
  tone?: 'color' | 'mono';
} | {
  Icon: typeof BrainCircuit;
  tone: 'component';
};

const colorIcon = (src: string): FilterIconAsset => ({ src, tone: 'color' });
const monoIcon = (src: string): FilterIconAsset => ({ src, tone: 'mono' });
const componentIcon = (Icon: typeof BrainCircuit): FilterIconAsset => ({ Icon, tone: 'component' });

function productIcon(value: string): FilterIconAsset | undefined {
  const id = value.toLowerCase();
  if (id.includes('claude')) return colorIcon(claudeCodeIcon);
  if (id.includes('codex')) return colorIcon(codexIcon);
  if (id.includes('gemini')) return colorIcon(geminiCliIcon);
  if (id.includes('kimi')) return monoIcon(kimiIcon);
  if (id.includes('copilot')) return monoIcon(copilotIcon);
  if (id.includes('trae')) return colorIcon(traeIcon);
  if (id.includes('qwen')) return colorIcon(qwenIcon);
  if (id.includes('antigravity')) return colorIcon(antigravityIcon);
  if (id.includes('amp')) return colorIcon(ampIcon);
  if (id.includes('cursor')) return monoIcon(cursorIcon);
  if (id.includes('opencode')) return monoIcon(opencodeIcon);
  return undefined;
}

function modelIcon(value: string, label: string): FilterIconAsset {
  const id = `${value} ${label}`.toLowerCase();
  if (id.includes('claude')) return colorIcon(claudeIcon);
  if (id.includes('anthropic')) return monoIcon(anthropicIcon);
  if (id.includes('deepseek')) return colorIcon(deepseekIcon);
  if (id.includes('gemini')) return colorIcon(geminiIcon);
  if (id.includes('glm') || id.includes('zhipu') || id.includes('智谱')) return colorIcon(glmvIcon);
  if (id.includes('kimi')) return monoIcon(kimiIcon);
  if (id.includes('moonshot')) return monoIcon(moonshotIcon);
  if (id.includes('openrouter')) return colorIcon(openrouterIcon);
  if (id.includes('qwen') || id.includes('通义')) return colorIcon(qwenIcon);
  if (id.includes('copilot')) return monoIcon(copilotIcon);
  if (id.includes('trae')) return colorIcon(traeIcon);
  if (id.includes('gpt') || /\bo\d/.test(id) || id.includes('openai')) return monoIcon(openaiIcon);
  return componentIcon(BrainCircuit);
}

// ────────────────────────────────────────
// Theme & Language Toggles
// ────────────────────────────────────────

const THEME_OPTIONS: { value: ThemeMode; icon: typeof Sun }[] = [
  { value: 'system', icon: Monitor },
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
];

const THEME_LABELS: Record<ThemeMode, { en: string; zh: string }> = {
  system: { en: 'System', zh: '系统' },
  light: { en: 'Light', zh: '日间' },
  dark: { en: 'Dark', zh: '夜间' },
};

function ThemeToggle({ value, onChange, locale }: { value: ThemeMode; onChange: (v: ThemeMode) => void; locale: Locale }) {
  return (
    <div className="inline-flex items-center rounded-md bg-slate-100/80 p-0.5 dark:bg-[#1a1a1a]/80">
      {THEME_OPTIONS.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-all duration-150 ${
              value === o.value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#222222] dark:text-slate-300'
                : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
            }`}
            aria-label={o.value}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{THEME_LABELS[o.value][locale]}</span>
          </button>
        );
      })}
    </div>
  );
}

function LangToggle({ value, onChange }: { value: Locale; onChange: (v: Locale) => void }) {
  return (
    <div className="inline-flex items-center rounded-md bg-slate-100/80 p-0.5 dark:bg-[#1a1a1a]/80">
      {(['en', 'zh'] as const).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          className={`rounded px-2 py-1 text-[11px] font-medium transition-all duration-150 ${
            value === l
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#222222] dark:text-slate-300'
              : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
          }`}
        >
          {l === 'en' ? 'EN' : '中'}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────────────────
// Controls
// ────────────────────────────────────────

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg bg-slate-100/80 p-0.5 dark:bg-[#1a1a1a]/80" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-all duration-150 ${
            value === o.value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#222222] dark:text-slate-300'
              : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterIcon({ icon }: { icon?: FilterIconAsset }) {
  if (!icon) return null;
  if (icon.tone === 'component') {
    const Icon = icon.Icon;
    return <Icon aria-hidden className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-300" strokeWidth={1.8} />;
  }
  if (icon.tone === 'mono') {
    return (
      <span
        aria-hidden
        className="h-4 w-4 shrink-0 bg-slate-600 dark:bg-slate-300"
        style={{
          WebkitMaskImage: `url("${icon.src}")`,
          WebkitMaskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          maskImage: `url("${icon.src}")`,
          maskPosition: 'center',
          maskRepeat: 'no-repeat',
          maskSize: 'contain',
        }}
      />
    );
  }
  return (
    <img
      src={icon.src}
      alt=""
      className="h-4 w-4 shrink-0 rounded-[3px]"
      loading="lazy"
    />
  );
}

function MultiSelectFilter({
  label,
  value,
  options,
  onChange,
  allLabel = 'All',
  locale,
  formatLabel = (text) => text,
  getIcon,
  tooltips,
}: {
  label: string;
  value: string[];
  options: FacetOption[];
  onChange: (v: string[]) => void;
  allLabel?: string;
  locale: Locale;
  formatLabel?: (label: string, value: string) => string;
  getIcon?: (option: FacetOption) => FilterIconAsset | undefined;
  tooltips?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = new Set(value);
  const selectedOptions = options.filter((option) => selected.has(option.value));
  const hasSelection = value.length > 0;
  const summary = !hasSelection
    ? allLabel
    : value.length === 1
      ? formatLabel(selectedOptions[0]?.label ?? value[0], value[0])
      : locale === 'zh' ? `${value.length} 项` : `${value.length} selected`;
  const selectedIcon = hasSelection && value.length === 1
    ? getIcon?.(selectedOptions[0] ?? { value: value[0], label: value[0] })
    : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  if (!options.length) return null;

  const toggleValue = (next: string) => {
    onChange(selected.has(next)
      ? value.filter((item) => item !== next)
      : [...value, next]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-white/20 ${
          hasSelection
            ? 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-200 dark:bg-[#222222] dark:text-slate-300 dark:ring-white/10'
            : 'bg-slate-100/80 text-slate-400 hover:text-slate-600 dark:bg-[#1a1a1a]/80 dark:text-slate-500 dark:hover:text-slate-300'
        }`}
      >
        <FilterIcon icon={selectedIcon} />
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate">{summary}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[min(320px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-[#111111] dark:shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
          <div className="max-h-80 overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-white/20 ${
                value.length === 0
                  ? 'bg-slate-50 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'
              }`}
            >
              <span className="flex h-4 w-4 items-center justify-center rounded border border-slate-200 text-slate-400 dark:border-white/15 dark:text-slate-500">
                {value.length === 0 && <Check className="h-3 w-3" />}
              </span>
              <span className="font-medium">{allLabel}</span>
            </button>

            {options.map((option) => {
              const checked = selected.has(option.value);
              const tip = tooltips?.[option.value];
              const icon = getIcon?.(option);
              return (
              <button
                key={option.value}
                type="button"
                title={tip}
                onClick={() => toggleValue(option.value)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:focus-visible:ring-white/20 ${
                  checked
                    ? 'bg-slate-100 text-slate-900 dark:bg-white/10 dark:text-slate-200'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'
                }`}
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  checked
                    ? 'border-slate-300 bg-slate-200 text-slate-600 dark:border-white/15 dark:bg-white/10 dark:text-slate-300'
                    : 'border-slate-200 dark:border-white/15'
                }`}>
                  {checked && <Check className="h-3 w-3" />}
                </span>
                {icon && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <FilterIcon icon={icon} />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{formatLabel(option.label, option.value)}</span>
                <span className="shrink-0 tabular-nums text-slate-300 dark:text-slate-600">
                  {formatCompact(option.eventCount ?? 0, locale)}
                </span>
              </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────
// App
// ────────────────────────────────────────

export function App() {
  const [filters, setFilters] = useState<FiltersState>({
    range: '30d',
    deviceIds: [],
    products: [],
    models: [],
  });

  const {
    overview,
    health,
    kpis,
    metricAvailability,
    fOpts,
    loading,
    error,
    isDemo,
    refresh,
  } = useOverview(filters);
  useFetchCnyRate();
  useCurrencyStore(); // subscribe to re-render on toggle
  useFaviconFromLogo();
  const isDark = useIsDark();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const h = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);


  // Theme
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme);
  const isFirstRender = useRef(true);
  const setTheme = useCallback((m: ThemeMode) => { setThemeState(m); applyTheme(m); }, []);
  useEffect(() => {
    applyTheme(theme, !isFirstRender.current);
    isFirstRender.current = false;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Locale
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem('aiusage-locale', l); } catch {}
  }, []);
  const t: T = I18N[locale];
  // Sync document title
  useEffect(() => {
    document.title = SITE_TITLE;
  }, []);

  // Token legend (locale-aware)
  const tokenLegendLabels: Record<string, keyof T> = {
    inputTokens: 'input', cachedInputTokens: 'cached',
    cacheWriteTokens: 'cacheWrite', outputTokens: 'output',
    reasoningOutputTokens: 'reasoning',
  };
  const tokenLegend = useMemo(() => {
    if (!overview) return [];
    const tc = overview.tokenComposition;
    return TOKEN_SERIES.map((s) => ({
      key: s.key,
      label: t[tokenLegendLabels[s.key] ?? 'input'],
      color: getTokenColor(s, isDark),
      value: formatCompact(arrSum(tc.map((d) => Number(d[s.key] || 0))), locale),
    }));
  }, [overview, t, locale, isDark]);
  const unavailable = metricAvailability.tokenMetricsUnavailable;
  const kpiDeltas = useMemo<Record<string, string | undefined>>(() => {
    const comparison = overview?.comparison;
    if (!overview || !comparison || filters.range === 'all') return {};
    const userMessageCount = typeof overview.interactionMetrics?.userMessageCount === 'number'
      ? overview.interactionMetrics.userMessageCount
      : undefined;
    return {
      totalCostUsd: formatDeltaPercent(overview.totalCostUsd, comparison.totalCostUsd),
      totalTokens: formatDeltaPercent(kpis?.totalTokens, comparison.totalTokens),
      inputTokens: formatDeltaPercent(kpis?.inputTokens, comparison.inputTokens),
      outputTokens: formatDeltaPercent(kpis?.outputTokens, comparison.outputTokens + comparison.reasoningOutputTokens),
      cachedTokens: formatDeltaPercent(kpis?.cachedTokens, comparison.cachedInputTokens),
      activeDays: formatDeltaPercent(overview.activeDays, comparison.activeDays),
      totalEvents: formatDeltaPercent(overview.totalEvents, comparison.totalEvents),
      userMessages: formatDeltaPercent(userMessageCount, comparison.userMessageCount),
      avgDailyCost: formatDeltaPercent(overview.averageDailyCostUsd, comparison.averageDailyCostUsd),
      cacheHitRate: formatDeltaPercent(kpis?.cacheHitRate, comparison.cacheHitRate),
    };
  }, [overview, kpis, filters.range]);
  const activityHeatmap = useMemo(() => buildActivityHeatmapData({
    heatmap: overview?.heatmap ?? [],
    dailyTrend: overview?.dailyTrend ?? [],
    tokenMetricsUnavailable: unavailable,
  }), [overview, unavailable]);

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 pb-16 sm:px-6 lg:px-8">

      {/* ── Header ── */}
      <header className="fade-up relative z-20 py-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-y-2">
          <h1 className="flex items-center gap-2 text-[18px] sm:text-[22px] font-semibold tracking-tight text-slate-900 dark:text-slate-300">
            <HeaderLogo />
            {SITE_TITLE}
          </h1>
          <div className="flex items-center gap-1.5 sm:gap-2 ml-auto">
            <ThemeToggle value={theme} onChange={setTheme} locale={locale} />
            <LangToggle value={locale} onChange={setLocale} />
            <button
              onClick={refresh}
              className="hidden sm:inline-flex items-center justify-center rounded-md bg-slate-100/80 p-1.5 text-slate-400 transition-colors hover:text-slate-600 dark:bg-[#1a1a1a]/80 dark:text-slate-500 dark:hover:text-slate-300"
              aria-label="Refresh"
            >
              <RotateCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

      </header>

      {isDemo && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          {t.demoBanner}
        </div>
      )}

        {/* ── Range + Filters ── */}
        <div className="mt-2 mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-hide">
            <SegmentedControl
              value={filters.range}
              options={getRanges(t)}
              onChange={(v) => setFilters((f) => ({ ...f, range: v }))}
            />
          </div>

          {overview && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <MultiSelectFilter
                label={t.tool}
                value={filters.products ?? []}
                options={fOpts.products}
                allLabel={t.all}
                locale={locale}
                formatLabel={(label) => formatProductLabel(label)}
                getIcon={(option) => productIcon(option.value)}
                onChange={(values) => setFilters((f) => ({ ...f, products: values }))}
                tooltips={{ 'claude-code': t.claudeCodeDataNotice }}
              />
              <MultiSelectFilter
                label={t.model}
                value={filters.models ?? []}
                options={fOpts.models}
                allLabel={t.all}
                locale={locale}
                formatLabel={(label) => formatModelName(label, isMobile)}
                getIcon={(option) => modelIcon(option.value, option.label)}
                onChange={(values) => setFilters((f) => ({ ...f, models: values }))}
              />
              <MultiSelectFilter
                label={t.device}
                value={filters.deviceIds ?? []}
                options={fOpts.devices}
                allLabel={t.all}
                locale={locale}
                onChange={(values) => setFilters((f) => ({ ...f, deviceIds: values }))}
              />
            </div>
          )}
        </div>

      {/* ── Content ── */}
      {loading && !overview ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`sa-${i}`} className="card px-5 py-5">
                <Skeleton className="mb-3 h-2.5 w-14" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={`sb-${i}`} className="card px-5 py-5">
                <Skeleton className="mb-3 h-2.5 w-14" />
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
          <div className="card p-6"><Skeleton className="h-[280px]" /></div>
          <div className="card p-6"><Skeleton className="h-[280px]" /></div>
        </div>
      ) : error ? (
        <div className="card flex min-h-[320px] flex-col items-center justify-center p-8">
          <div className="mb-1.5 text-[13px] text-slate-400 dark:text-slate-500">{t.failedToLoad}</div>
          <div className="text-[13px] text-red-500/80">{error}</div>
        </div>
      ) : (
        <div className="grid gap-4">

          {/* ── KPI Row 1 ── */}
          <div
            className="fade-up grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            style={{ animationDelay: '50ms' }}
          >
            <div className="card col-span-2 sm:col-span-1">
              <CostKpiCard
                label={t.estimatedCost}
                value={unavailable ? t.unavailable : formatUsd(overview?.totalCostUsd ?? 0)}
                delta={unavailable ? undefined : kpiDeltas.totalCostUsd}
              />
            </div>
            <div className="card">
              <KpiCard label={t.totalTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} delta={unavailable ? undefined : kpiDeltas.totalTokens} />
            </div>
            <div className="card">
              <KpiCard label={t.inputTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.inputTokens ?? 0, locale)} delta={unavailable ? undefined : kpiDeltas.inputTokens} />
            </div>
            <div className="card">
              <KpiCard label={t.outputTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.outputTokens ?? 0, locale)} delta={unavailable ? undefined : kpiDeltas.outputTokens} />
            </div>
            <div className="card">
              <KpiCard label={t.cachedTokens} value={unavailable ? t.unavailable : formatCompact(kpis?.cachedTokens ?? 0, locale)} delta={unavailable ? undefined : kpiDeltas.cachedTokens} />
            </div>
          </div>

          {/* ── KPI Row 2 ── */}
          <div
            className="fade-up grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            style={{ animationDelay: '100ms' }}
          >
            <div className="card col-span-2 sm:col-span-1">
              <KpiCard
                label={t.activeDays}
                value={String(overview?.activeDays ?? 0)}
                suffix={` / ${overview?.totalDays ?? 0}`}
                delta={kpiDeltas.activeDays}
              />
            </div>
            <div className="card">
              <KpiCard
                label={t.totalEvents}
                value={formatNumber(overview?.totalEvents ?? 0)}
                delta={kpiDeltas.totalEvents}
              />
            </div>
            <div className="card">
              <KpiCard
                label={t.userMessages}
                value={typeof overview?.interactionMetrics?.userMessageCount === 'number'
                  ? formatNumber(overview.interactionMetrics.userMessageCount)
                  : t.unavailable}
                delta={kpiDeltas.userMessages}
              />
            </div>
            <div className="card">
              <KpiCard label={t.avgDailyCost} value={unavailable ? t.unavailable : formatUsd(overview?.averageDailyCostUsd ?? 0)} delta={unavailable ? undefined : kpiDeltas.avgDailyCost} />
            </div>
            <div className="card">
              <KpiCard label={t.cacheHitRate} value={unavailable ? t.unavailable : formatPercent(kpis?.cacheHitRate ?? 0)} delta={unavailable ? undefined : kpiDeltas.cacheHitRate} />
            </div>
          </div>

          {unavailable && (
            <div className="fade-up rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-900 dark:border-amber-950/60 dark:bg-amber-950/20 dark:text-amber-200">
              <span className="font-medium">{t.eventOnlySource}.</span> {t.eventOnlyNotice}
            </div>
          )}

          {/* ── Activity Heatmap ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '120ms' }}>
            <SectionHeader title={locale === 'zh' ? '年度活跃热力图' : 'Activity Heatmap'} />
            <ActivityHeatmap days={activityHeatmap.days} metricLabel={activityHeatmap.metricLabel} locale={locale} />
          </div>

          {/* ── Cost Trend ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '180ms' }}>
            <SectionHeader title={t.costTrend} stat={unavailable ? t.unavailable : formatUsd(overview?.totalCostUsd ?? 0)} />
            {unavailable ? (
              <EmptyState label={t.costUnavailable} />
            ) : (
              <ChartBoundary name="Cost Trend">
                <CostTrendChart
                  data={overview?.dailyTrend ?? []}
                  providerTrend={overview?.providerDailyTrend ?? []}
                />
              </ChartBoundary>
            )}
          </div>

          {/* ── Prompt Trend ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '205ms' }}>
            <SectionHeader
              title={t.promptTrend}
              stat={typeof overview?.interactionMetrics?.userMessageChars === 'number'
                ? `${formatNumber(overview.interactionMetrics.userMessageCount ?? 0)} / ${formatCompact(overview.interactionMetrics.userMessageChars, locale)}`
                : undefined}
            />
            <ChartBoundary name="Prompt Trend">
              <PromptTrendChart
                data={overview?.interactionMetrics?.promptTrend ?? []}
                dates={(overview?.dailyTrend ?? []).map(d => d.usageDate)}
                locale={locale}
                labels={{ messageCount: t.promptMessages, charCount: t.promptChars }}
              />
            </ChartBoundary>
          </div>

          {/* ── Token Trend ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '230ms' }}>
            <SectionHeader title={t.tokenTrend} stat={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} />
            {unavailable ? (
              <EmptyState label={t.tokenUnavailable} />
            ) : (
              <ChartBoundary name="Token Trend">
                <TokenTrendChart
                  data={overview?.tokenComposition ?? []}
                  locale={locale}
                  totalLabel={t.total}
                  legendItems={tokenLegend}
                />
              </ChartBoundary>
            )}
          </div>

          {/* ── Token Composition ── */}
          <div className="card fade-up p-6" style={{ animationDelay: '280ms' }}>
            <SectionHeader title={t.tokenComposition} stat={unavailable ? t.unavailable : formatCompact(kpis?.totalTokens ?? 0, locale)} />
            {unavailable ? (
              <EmptyState label={t.tokenUnavailable} />
            ) : (
              <>
                <ChartBoundary name="Token Composition">
                  <TokenCompositionChart data={overview?.tokenComposition ?? []} locale={locale} totalLabel={t.total} />
                </ChartBoundary>
                <ChartLegend items={tokenLegend} />
              </>
            )}
          </div>

          {/* ── Flow & Share ── */}
          <div className="fade-up grid gap-4 lg:grid-cols-5" style={{ animationDelay: '330ms' }}>
            <div className="card p-6 lg:col-span-3">
              <SectionHeader title={t.tokenFlow} />
              {unavailable ? (
                <EmptyState label={t.tokenUnavailable} />
              ) : (
                <ChartBoundary name="Token Flow">
                  <FlowChart data={overview?.sankey} />
                </ChartBoundary>
              )}
            </div>
            <div className="card flex flex-col p-6 lg:col-span-2">
              {unavailable ? (
                <EmptyState label={t.shareUnavailable} />
              ) : (
                <ChartBoundary name="Share">
                  <div className="flex flex-1 flex-col">
                    <DonutSection
                      title={t.providerShare}
                      data={(overview?.filters.options.providers ?? []).map((p) => ({
                        value: p.value,
                        label: providerLabel(p.value),
                        estimatedCostUsd: p.estimatedCostUsd,
                        eventCount: p.eventCount,
                      }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatUsd(overview?.totalCostUsd ?? 0)}
                    />
                    <div className="my-5 border-t border-slate-100 dark:border-white/[0.08]" />
                    <DonutSection
                      title={t.modelShare}
                      data={(overview?.modelCostShare ?? []).map((m) => ({ ...m, label: formatModelName(m.label, isMobile) }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatUsd(overview?.totalCostUsd ?? 0)}
                    />
                    <div className="my-5 border-t border-slate-100 dark:border-white/[0.08]" />
                    <DonutSection
                      title={t.deviceShare}
                      data={(overview?.filters.options.devices ?? []).map((d) => ({
                        value: d.value,
                        label: d.label,
                        estimatedCostUsd: d.estimatedCostUsd,
                        eventCount: d.eventCount,
                      }))}
                      colors={getChartColors(isDark)}
                      centerLabel={formatUsd(overview?.totalCostUsd ?? 0)}
                    />
                  </div>
                </ChartBoundary>
              )}
            </div>
          </div>

        </div>
      )}

      {/* ── Footer ── */}
      <footer className="fade-up mt-16 border-t border-slate-100 dark:border-white/[0.08] pb-10 pt-8">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center gap-3 text-[12px] text-slate-400 dark:text-slate-500">
            <span className="flex items-center gap-1.5 font-medium text-slate-500 dark:text-slate-400">
              <FooterLogo />
              {SITE_TITLE}
            </span>
            {health?.version && (
              <span className="rounded-full bg-slate-100 dark:bg-[#1a1a1a] px-2 py-0.5 text-[10px] font-medium text-slate-400 dark:text-slate-500">
                v{health.version}
              </span>
            )}
          </div>
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-[11px] text-slate-300 dark:text-slate-600">
            <div className="flex items-center gap-4">
              <a
                href="/embed/docs"
                className="text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {t.embedWidgets}
              </a>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/imetn/aiusage"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <Github className="h-3.5 w-3.5" />
                <span>GitHub</span>
              </a>
              <span className="h-3 w-px bg-slate-200 dark:bg-[#222222]" />
              <span className="flex items-center gap-1">
                Made with <Heart className="h-3 w-3 fill-red-300 text-red-300" /> by{' '}
                <a
                  href="https://x.com/qingnianxiaozhe"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                >
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
                  qingnianxiaozhe
                </a>
              </span>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
