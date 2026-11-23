// These are reporting aliases. The original model and provider still identify the stored usage and its price.
const MODEL_GROUP_ALIASES: Record<string, string> = {
  'auto/deepseek-v4.1-flash': 'deepseek-v4.1-flash',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
  'factory/deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
  'group/auto-deepseek-v4-1-flash': 'deepseek-v4.1-flash',
  'opensource/deepseek_v4_1_flash': 'deepseek-v4.1-flash',
  'opensource/glm5.2': 'glm-5.2',
  'gpt-oss-120b-medium': 'gpt-oss-120b',
  'grok-4.7-fast': 'grok-4.7',
  'grok/grok-4.7': 'grok-4.7',
  'group/auto-grok-4-7': 'grok-4.7',
};

const CLAUDE_PREFIXES = ['', 'factory/', 'group/auto-'];
const REASONING_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const GPT_SERVICE_SUFFIXES = ['fast', 'priority', 'ultrafast', 'batch', 'flex'];

// The column expression is supplied by the query, with search values bound separately.
function modelGroupSql(column: string): string {
  const aliases = Object.entries(MODEL_GROUP_ALIASES)
    .map(([alias, model]) => `WHEN ${column} = '${alias}' THEN '${model}'`);
  const separator = `instr(${column}, ':')`;
  const levels = REASONING_LEVELS.map(level => `'${level}'`).join(', ');
  const claude = CLAUDE_PREFIXES.map(prefix => {
    const start = prefix.length + 1;
    const length = `CASE WHEN substr(${column}, ${separator} + 1) IN (${levels})
      THEN ${separator} - ${start} ELSE length(${column}) - ${start - 1} END`;
    const name = `substr(${column}, ${start}, ${length})`;
    const effort = REASONING_LEVELS.map(level => `WHEN ${name} GLOB 'claude-*-${level}' THEN ${length} - ${level.length + 1}`).join(' ');
    const effortLength = `CASE ${effort} ELSE ${length} END`;
    const effortName = `substr(${column}, ${start}, ${effortLength})`;
    const withoutSpeed = `CASE WHEN ${effortName} GLOB 'claude-*-fast' THEN substr(${column}, ${start}, (${effortLength}) - 5) ELSE ${effortName} END`;
    return `WHEN ${column} GLOB '${prefix}claude-*' THEN replace(${withoutSpeed}, '.', '-')`;
  });
  const geminiEffort = REASONING_LEVELS.map(level =>
    `WHEN ${column} GLOB 'gemini-*-${level}' THEN substr(${column}, 1, length(${column}) - ${level.length + 1})`,
  );
  const speeds = GPT_SERVICE_SUFFIXES.map(suffix =>
    `WHEN ${column} GLOB 'gpt-[0-9]*-${suffix}' THEN substr(${column}, 1, length(${column}) - ${suffix.length + 1})`,
  );
  return `CASE ${[...aliases, ...speeds, ...geminiEffort, ...claude].join('\n')} ELSE ${column} END`;
}

export const MODEL_GROUP_SQL = modelGroupSql('b.model');

export function addModelFilter(clauses: string[], params: (string | number)[], models: string[]) {
  if (!models.length) return;
  // Keep exact selection by a raw identifier while also allowing selection by the group shown in the dashboard.
  const selection = JSON.stringify(models);
  const values = 'SELECT value FROM json_each(?)';
  clauses.push(`(b.model IN (${values}) OR ${MODEL_GROUP_SQL} IN (${values}))`);
  params.push(selection, selection);
}
