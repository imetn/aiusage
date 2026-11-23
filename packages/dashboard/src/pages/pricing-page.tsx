import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useLayout } from '../components/layout';
import type { T } from '../i18n';
import type { ModelPricing, PricingCatalog } from '@aiusage/shared';
import { formatPricingRate } from '../utils/pricing-display';

// ────────────────────────────────────────
// Types
// ────────────────────────────────────────

// ────────────────────────────────────────
// Provider branding
// ────────────────────────────────────────

interface ProviderBrand {
  color: string;
  darkColor?: string;
}

const PROVIDER_BRANDS: Record<string, ProviderBrand> = {
  anthropic: { color: '#D97757' },
  openai: { color: '#171717', darkColor: '#e6edf3' },
  google: { color: '#4285F4' },
  github: { color: '#24292F', darkColor: '#e6edf3' },
  sourcegraph: { color: '#FF5543' },
};

const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'github', 'sourcegraph'];

// ────────────────────────────────────────
// SVG Logos
// ────────────────────────────────────────

function AnthropicLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 46 32" fill="currentColor" className={className}>
      <path d="M32.73 0h-6.945L38.45 32h6.945L32.73 0ZM12.665 0 0 32h7.082l2.59-6.72h13.25l2.59 6.72h7.082L19.929 0h-7.264Zm-.702 19.337 4.334-11.246 4.334 11.246h-8.668Z" />
    </svg>
  );
}

function OpenAILogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function GitHubLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function SourcegraphLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M14.39 1.54l8.07 8.07a2.73 2.73 0 010 3.86l-3.6 3.6-1.5-1.14 3.73-3.73a1.23 1.23 0 000-1.74l-7.34-7.34a1.23 1.23 0 00-1.74 0L8.28 6.85 6.78 5.71l3.75-3.75a2.73 2.73 0 013.86-.42zm-4.78 20.5l-8.07-8.07a2.73 2.73 0 010-3.86l3.6-3.6 1.5 1.14-3.73 3.73a1.23 1.23 0 000 1.74l7.34 7.34a1.23 1.23 0 001.74 0l3.73-3.73 1.5 1.14-3.75 3.75a2.73 2.73 0 01-3.86.42zM19.5 17.25a2.25 2.25 0 110 4.5 2.25 2.25 0 010-4.5zM4.5 2.25a2.25 2.25 0 110 4.5 2.25 2.25 0 010-4.5z" />
    </svg>
  );
}

const LOGO_COMPONENTS: Record<string, (props: { className?: string }) => JSX.Element> = {
  anthropic: AnthropicLogo,
  openai: OpenAILogo,
  google: GoogleLogo,
  github: GitHubLogo,
  sourcegraph: SourcegraphLogo,
};

// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

function countProducts(
  providers: Record<string, Record<string, { models: Record<string, ModelPricing> }>>,
): number {
  return Object.values(providers).reduce((sum, products) => sum + Object.keys(products).length, 0);
}

function countModels(
  providers: Record<string, Record<string, { models: Record<string, ModelPricing> }>>,
): number {
  return Object.values(providers).reduce(
    (sum, products) =>
      sum + Object.values(products).reduce((s, p) => s + Object.keys(p.models).length, 0),
    0,
  );
}

function getBrandColor(provider: string, isDark: boolean): string {
  const brand = PROVIDER_BRANDS[provider.toLowerCase()];
  if (!brand) return '#6366f1';
  return isDark && brand.darkColor ? brand.darkColor : brand.color;
}

// ────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────

function StatCard({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="card px-4 py-4 sm:px-5 sm:py-5">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:text-slate-500">
        {label}
      </div>
      <div
        className={`mt-1.5 tracking-tight tabular-nums leading-none font-semibold text-slate-900 dark:text-slate-400 ${
          small ? 'text-[15px]' : 'text-[22px]'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ProviderSection({
  provider,
  products,
  fx,
  collapsed,
  onToggle,
  isDark,
  t,
}: {
  provider: string;
  products: Record<string, { models: Record<string, ModelPricing> }>;
  fx: PricingCatalog['fx'];
  collapsed: boolean;
  onToggle: () => void;
  isDark: boolean;
  t: T;
}) {
  const brandColor = getBrandColor(provider, isDark);
  const isAnthropic = provider.toLowerCase() === 'anthropic';
  const productCount = Object.keys(products).length;
  const modelCount = Object.values(products).reduce(
    (sum, p) => sum + Object.keys(p.models).length,
    0,
  );
  const displayName = provider.charAt(0).toUpperCase() + provider.slice(1);
  const LogoComponent = LOGO_COMPONENTS[provider.toLowerCase()];

  const sortedProducts = Object.entries(products).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="card overflow-hidden">
      {/* Provider header bar */}
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50/60 dark:hover:bg-white/[0.02] sm:flex-row"
        style={{ borderLeft: `4px solid ${brandColor}` }}
      >
        <div className="flex items-center gap-3">
          {LogoComponent && (
            <span style={{ color: brandColor }} className="flex shrink-0 items-center">
              <LogoComponent className="h-6 w-6" />
            </span>
          )}
          <span className="text-[18px] font-semibold tracking-tight text-slate-900 dark:text-slate-300">
            {displayName}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-slate-100/80 px-2.5 py-0.5 text-[12px] font-medium text-slate-400 dark:bg-white/[0.06] dark:text-slate-500">
            {productCount} {t.products.toLowerCase()}
          </span>
          <span className="inline-flex items-center rounded-full bg-slate-100/80 px-2.5 py-0.5 text-[12px] font-medium text-slate-400 dark:bg-white/[0.06] dark:text-slate-500">
            {modelCount} {t.models.toLowerCase()}
          </span>
          <ChevronDown
            className={`h-4 w-4 text-slate-300 transition-transform duration-200 dark:text-slate-600 ${
              collapsed ? '-rotate-90' : ''
            }`}
          />
        </div>
      </button>

      {/* Provider body */}
      {!collapsed && (
        <div className="flex flex-col gap-5 px-5 pb-5">
          {sortedProducts.map(([product, def]) => (
            <ProductTable
              key={product}
              product={product}
              models={def.models}
              fx={fx}
              isAnthropic={isAnthropic}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductTable({
  product,
  models,
  fx,
  isAnthropic,
  t,
}: {
  product: string;
  models: Record<string, ModelPricing>;
  fx: PricingCatalog['fx'];
  isAnthropic: boolean;
  t: T;
}) {
  const sortedModels = Object.entries(models).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <div className="mb-2 flex items-center gap-2.5">
        <span className="text-[14px] font-semibold text-slate-900 dark:text-slate-300">
          {product}
        </span>
        <span className="text-[12px] text-slate-400 dark:text-slate-500">
          {sortedModels.length} {t.models.toLowerCase()}
        </span>
      </div>
      <div className="overflow-x-auto scrollbar-hide">
        <table className="w-full border-collapse whitespace-nowrap">
          <thead>
            <tr>
              <th className="border-b border-slate-100 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                MODEL
              </th>
              <th className="border-b border-slate-100 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                {t.inputPrice.toUpperCase()}
              </th>
              <th className="border-b border-slate-100 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                {t.cacheHitPrice.toUpperCase()}
              </th>
              {isAnthropic && (
                <>
                  <th className="border-b border-slate-100 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                    {t.cacheWrite5m.toUpperCase()}
                  </th>
                  <th className="border-b border-slate-100 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                    {t.cacheWrite1h.toUpperCase()}
                  </th>
                </>
              )}
              <th className="border-b border-slate-100 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                {t.outputPrice.toUpperCase()}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedModels.map(([model, pricing]) => (
              <tr key={model} className="group">
                <td className="border-b border-slate-50 px-3 py-2 font-mono text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                  {model}
                </td>
                <td className="border-b border-slate-50 px-3 py-2 text-right tabular-nums text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                  {formatPricingRate(pricing, 'input_per_million', fx)}
                </td>
                <td className="border-b border-slate-50 px-3 py-2 text-right tabular-nums text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                  {formatPricingRate(pricing, 'cached_input_per_million', fx)}
                </td>
                {isAnthropic && (
                  <>
                    <td className="border-b border-slate-50 px-3 py-2 text-right tabular-nums text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                      {formatPricingRate(pricing, 'cache_write_5m_per_million', fx)}
                    </td>
                    <td className="border-b border-slate-50 px-3 py-2 text-right tabular-nums text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                      {formatPricingRate(pricing, 'cache_write_1h_per_million', fx)}
                    </td>
                  </>
                )}
                <td className="border-b border-slate-50 px-3 py-2 text-right tabular-nums text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                  {formatPricingRate(pricing, 'output_per_million', fx)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AliasesSection({
  aliases,
  collapsed,
  onToggle,
  t,
}: {
  aliases: Record<string, string>;
  collapsed: boolean;
  onToggle: () => void;
  t: T;
}) {
  const sortedAliases = Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50/60 dark:hover:bg-white/[0.02]"
      >
        <span className="text-[16px] font-semibold text-slate-900 dark:text-slate-300">
          {t.modelAliases}
        </span>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-slate-100/80 px-2.5 py-0.5 text-[12px] font-medium text-slate-400 dark:bg-white/[0.06] dark:text-slate-500">
            {sortedAliases.length} aliases
          </span>
          <ChevronDown
            className={`h-4 w-4 text-slate-300 transition-transform duration-200 dark:text-slate-600 ${
              collapsed ? '-rotate-90' : ''
            }`}
          />
        </div>
      </button>
      {!collapsed && (
        <div className="px-5 pb-5">
          <div className="overflow-x-auto scrollbar-hide">
            <table className="w-full border-collapse whitespace-nowrap">
              <thead>
                <tr>
                  <th className="border-b border-slate-100 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                    {t.alias.toUpperCase()}
                  </th>
                  <th className="border-b border-slate-100 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
                    {t.resolvedModel.toUpperCase()}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedAliases.map(([alias, resolved]) => (
                  <tr key={alias} className="group">
                    <td className="border-b border-slate-50 px-3 py-2 font-mono text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                      {alias}
                    </td>
                    <td className="border-b border-slate-50 px-3 py-2 font-mono text-[13px] text-slate-700 group-last:border-b-0 dark:border-white/[0.04] dark:text-slate-400">
                      {resolved}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────
// Page
// ────────────────────────────────────────

export function PricingPage() {
  const { locale, t, isDark } = useLayout();
  const [catalog, setCatalog] = useState<PricingCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/public/pricing');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: PricingCatalog = await res.json();
        if (!cancelled) setCatalog(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (provider: string) =>
    setCollapsed((prev) => ({ ...prev, [provider]: !prev[provider] }));

  // Loading
  if (!catalog && !error) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <span className="text-[13px] text-slate-400 dark:text-slate-500">{t.loadingPricing}</span>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="card flex min-h-[320px] flex-col items-center justify-center p-8">
        <div className="mb-1.5 text-[13px] text-slate-400 dark:text-slate-500">
          {t.failedLoadPricing}
        </div>
        <div className="text-[13px] text-red-500/80">{error}</div>
      </div>
    );
  }

  if (!catalog) return null;

  // Sort providers by defined order
  const sortedProviders = Object.entries(catalog.providers).sort(([a], [b]) => {
    const ai = PROVIDER_ORDER.indexOf(a.toLowerCase());
    const bi = PROVIDER_ORDER.indexOf(b.toLowerCase());
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <div className="grid gap-4">
      {/* Stats bar */}
      <div
        className="fade-up grid grid-cols-2 gap-3 sm:grid-cols-4"
        style={{ animationDelay: '50ms' }}
      >
        <StatCard label={t.pricingVersion} value={catalog.version} small />
        <StatCard label={t.providers} value={Object.keys(catalog.providers).length} />
        <StatCard label={t.products} value={countProducts(catalog.providers)} />
        <StatCard label={t.models} value={countModels(catalog.providers)} />
      </div>

      {/* Provider sections */}
      {sortedProviders.map(([provider, products], i) => (
        <div
          key={provider}
          className="fade-up"
          style={{ animationDelay: `${100 + i * 50}ms` }}
        >
          <ProviderSection
            provider={provider}
            products={products}
            fx={catalog.fx}
            collapsed={!!collapsed[provider]}
            onToggle={() => toggle(provider)}
            isDark={isDark}
            t={t}
          />
        </div>
      ))}

      {/* Aliases */}
      <div
        className="fade-up"
        style={{ animationDelay: `${100 + sortedProviders.length * 50}ms` }}
      >
        <AliasesSection
          aliases={catalog.aliases}
          collapsed={!!collapsed['__aliases__']}
          onToggle={() => toggle('__aliases__')}
          t={t}
        />
      </div>

      {/* Footer note */}
      <div className="fade-up pb-2 text-center text-[12px] text-slate-400 dark:text-slate-500">
        {t.perMillionTokens}
      </div>
    </div>
  );
}
