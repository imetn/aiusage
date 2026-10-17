// ── 统计维度 ──

export type Provider = 'anthropic' | 'openai' | 'google' | 'github' | 'alibaba' | 'moonshot' | 'sourcegraph' | 'inflection' | 'cursor' | 'trae' | 'zhipu' | (string & {});
export type Product = 'claude-code' | 'codex' | 'copilot-cli' | 'copilot-vscode' | 'gemini-cli' | 'antigravity' | 'qwen-code' | 'kimi-code' | 'amp' | 'droid' | 'opencode' | 'pi' | 'cursor' | 'trae' | 'trae-cn' | 'trae-intl' | (string & {});
export type Channel = 'cli' | 'ide' | 'web' | 'api';
export type CostStatus = 'exact' | 'estimated' | 'unavailable';
export type DeviceStatus = 'active' | 'disabled';
export type ProjectVisibility = 'hidden' | 'masked' | 'plain';

// ── 上报格式 ──

export interface IngestPayload {
  siteId: string;
  schemaVersion: string;
  generatedAt: string;
  device: DeviceInfo;
  days: IngestDay[];
}

export interface DeviceInfo {
  deviceId: string;
  deviceAlias?: string;
  hostname: string;
  timezone: string;
  appVersion: string;
}

export interface IngestDay {
  usageDate: string;
  breakdowns: IngestBreakdown[];
  activity?: IngestActivityDay;
}

export interface IngestBreakdown {
  provider: Provider;
  product: Product;
  channel: Channel;
  model: string;
  project: string;
  projectDisplay?: string;
  projectAlias?: string;
  eventCount: number;
  sessionCount?: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUSD?: number;
  pricingVersion?: string;
}

export interface IngestActivityDay {
  items: IngestActivityItem[];
}

export interface IngestActivityItem {
  provider: Provider;
  product: Product;
  source: string;
  project: string;
  projectDisplay?: string;
  projectAlias?: string;
  kind: string;
  name: string;
  count: number;
  confidence: 'exact' | 'proxy';
}

// ── API 响应 ──

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  siteId: string;
  service: 'aiusage';
  version: string;
  time: string;
}

export interface EnrollResponse {
  siteId: string;
  deviceId: string;
  deviceToken: string;
  issuedAt: string;
}

export interface IngestResponse {
  daysProcessed: number;
  costSummary: Record<string, { estimatedCostUsd: number; costStatus: CostStatus }>;
}

// ── 公开接口 ──

export interface OverviewResponse {
  totalDays: number;
  activeDays: number;
  totalEvents: number;
  totalSessions: number;
  costBearingEvents: number;
  totalCostUsd: number;
  averageDailyCostUsd: number;
  dailyTrend: DailyTrendItem[];
  providerDailyTrend: ProviderDailyTrendItem[];
  tokenComposition: TokenCompositionItem[];
  modelCostShare: ShareItem[];
  channelCostShare: ShareItem[];
  sankey: SankeyGraph;
  heatmap: HeatmapDay[];
  interactionMetrics?: InteractionMetricsPayload;
  comparison?: OverviewComparisonPayload | null;
  filters: DashboardFiltersPayload;
}

export interface OverviewComparisonPayload {
  activeDays: number;
  totalEvents: number;
  totalSessions: number;
  totalCostUsd: number;
  averageDailyCostUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  userMessageCount?: number;
}

export interface InteractionMetricItem {
  value: string;
  label: string;
  eventCount: number;
  proxyCount?: number;
}

export interface InteractionMetricsPayload {
  exactCount: number;
  proxyCount: number;
  userMessageCount?: number;
  userMessageChars?: number;
  promptTrend?: PromptTrendItem[];
  functionCallCount: number;
  toolCallCount: number;
  skillCallCount: number;
  skillProxyCount: number;
  subagentCount: number;
  topTools: InteractionMetricItem[];
  topSkills: InteractionMetricItem[];
  topAgents: InteractionMetricItem[];
  kindShare: InteractionMetricItem[];
}

export interface PromptTrendItem {
  usageDate: string;
  messageCount: number;
  charCount: number;
}

export interface DailyTrendItem {
  usageDate: string;
  eventCount: number;
  estimatedCostUsd: number;
}

export interface ProviderDailyTrendItem {
  usageDate: string;
  provider: string;
  estimatedCostUsd: number;
}

export interface TokenCompositionItem {
  usageDate: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ShareItem {
  value: string;
  label: string;
  estimatedCostUsd: number;
  eventCount: number;
}

export interface SankeyNode {
  id: string;
  label: string;
  layer: number;
  totalTokens: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyGraph {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export interface FacetOption {
  value: string;
  label: string;
  estimatedCostUsd: number;
  eventCount: number;
}

export interface DashboardFiltersPayload {
  selection: {
    range: string;
    deviceId: string[];
    provider: string[];
    product: string[];
    channel: string[];
    model: string[];
    project: string[];
  };
  options: {
    devices: FacetOption[];
    providers: FacetOption[];
    products: FacetOption[];
    channels: FacetOption[];
    models: FacetOption[];
    projects: FacetOption[];
  };
}

export interface BreakdownItem {
  deviceId: string;
  usageDate: string;
  provider: Provider;
  product: Product;
  channel: Channel;
  model: string;
  project: string;
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens?: number;
  estimatedCostUsd: number;
  costStatus: CostStatus;
}

// ── 热力图 ──

export interface HeatmapDay {
  usageDate: string;       // YYYY-MM-DD
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface HeatmapResponse {
  days: HeatmapDay[];
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
