const ROUTING_PREFIX_RE = /^(?:group\/(?:auto-)?|factory\/|auto\/|opensource\/|grok\/(?=grok[-.])|agy-cli\/)/i;
const ROUTING_PROVIDERS = new Set(['group', 'factory', 'auto', 'opensource', 'grok', 'agy-cli']);
const EFFORT_SUFFIX_RE = /:(?:none|low|medium|high|xhigh|max)$/i;

/** 判断 provider 名是否只是网关/路由包装名而非真实模型供应商。 */
export function isRoutingProvider(provider: string | undefined): boolean {
  return provider != null && ROUTING_PROVIDERS.has(provider.trim().toLowerCase());
}

/** 根据模型名推断底层供应商；无法识别时返回 fallback。 */
export function inferProviderFromModel(model: string, fallback: string): string {
  const value = model.trim().toLowerCase();
  if (/^(claude|opus|sonnet|haiku)(?:[-.]|$)/.test(value)) return 'anthropic';
  if (/^(gpt|chatgpt|codex|o[134])(?:[-.]|$)/.test(value)) return 'openai';
  if (/^gemini(?:[-.]|$)/.test(value)) return 'google';
  if (/^qwen(?:[-.]|$)/.test(value)) return 'alibaba';
  if (/^deepseek(?:[-._]|$)/.test(value)) return 'deepseek';
  if (/^(glm|codegeex)(?:[-.\d]|$)/.test(value)) return 'zhipu';
  if (/^(kimi|moonshot)(?:[-/.]|$)/.test(value)) return 'moonshot';
  if (/^grok(?:[-.]|$)/.test(value)) return 'xai';
  return fallback;
}

/**
 * 剥离路由网关前缀（如 `group/auto-`、`group/`、`factory/`、`auto/`、`opensource/`、`grok/`）
 * 及末尾推理档位后缀（`:high` 等），还原标准模型 ID。
 *
 * 非路由前缀（如 `model_api/experimental_0630`、`kimi-code/k3`）保持原样。
 */
export function normalizeRoutedModel(rawModel: string): { model: string; stripped: boolean } {
  const trimmed = rawModel.trim();
  const match = ROUTING_PREFIX_RE.exec(trimmed);
  const stripped = Boolean(match);
  let model = (match ? trimmed.slice(match[0].length) : trimmed).replace(EFFORT_SUFFIX_RE, '');

  if (stripped) {
    const lower = model.toLowerCase();
    if (lower.startsWith('claude-')) {
      model = model.replace(/\./g, '-');
    } else if (/^grok-\d+-\d+(?:-|$)/i.test(model)) {
      model = model.replace(/^(grok-\d+)-(\d+)/i, '$1.$2');
    } else if (/^deepseek[_-]v\d+[_-]\d+/i.test(model)) {
      model = model.replace(/_/g, '-').replace(/^(deepseek-v\d+)-(\d+)/i, '$1.$2');
    } else if (/^glm\d/i.test(model)) {
      model = model.replace(/^(glm)(\d)/i, '$1-$2');
    }
  }

  return { model: model || trimmed, stripped };
}
