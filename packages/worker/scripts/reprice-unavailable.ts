// Reprices daily_usage_breakdown rows stored as `unavailable` using the bundled
// pricing catalog and their stored token counts.
//
//   pnpm --filter @aiusage/worker reprice              # dry run: show what would change
//   pnpm --filter @aiusage/worker reprice -- --apply   # write to the remote D1 database
//   ... -- --config /path/to/wrangler.jsonc            # config with database_id (local use)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepriceSql, repriceRow, type StoredBreakdownRow } from '../src/utils/reprice.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const configIndex = args.indexOf('--config');
const configArgs = configIndex >= 0 ? ['--config', args[configIndex + 1]] : [];

function wrangler(extra: string[]): string {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'aiusage-db', '--remote', ...configArgs, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const output = wrangler([
  '--json',
  '--command',
  `SELECT device_id, usage_date, provider, product, channel, model, project, event_count,
          input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
          reasoning_output_tokens, extra_metrics_json
   FROM daily_usage_breakdown WHERE cost_status = 'unavailable' AND event_count > 0`,
]);
const rows = (JSON.parse(output) as Array<{ results: StoredBreakdownRow[] }>)[0].results;

const repriced = rows.map(repriceRow).filter(result => result !== null);
const byModel = new Map<string, { rows: number; cost: number }>();
for (const { row, estimatedCostUsd } of repriced) {
  const key = `${row.provider}/${row.product}/${row.model}`;
  const entry = byModel.get(key) ?? { rows: 0, cost: 0 };
  entry.rows += 1;
  entry.cost += estimatedCostUsd;
  byModel.set(key, entry);
}

console.log(`Unavailable rows: ${rows.length}; priceable with the current catalog: ${repriced.length}`);
for (const [key, { rows: count, cost }] of byModel) {
  console.log(`- ${key}: ${count} rows, $${cost.toFixed(2)}`);
}
const unpriceable = new Set(rows.filter(row => !repriced.some(r => r.row === row)).map(row => `${row.provider}/${row.product}/${row.model}`));
if (unpriceable.size > 0) console.log(`Still without a price: ${[...unpriceable].join(', ')}`);

if (repriced.length === 0) process.exit(0);
if (!apply) {
  console.log('Dry run only. Re-run with --apply to write these costs.');
  process.exit(0);
}

const file = join(mkdtempSync(join(tmpdir(), 'aiusage-reprice-')), 'reprice.sql');
writeFileSync(file, buildRepriceSql(repriced, new Date().toISOString()));
wrangler(['--yes', '--file', file]);
console.log(`Repriced ${repriced.length} rows.`);
