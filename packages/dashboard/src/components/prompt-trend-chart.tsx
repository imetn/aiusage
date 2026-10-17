import { useMemo } from 'react';
import {
  Area, Bar, ComposedChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis, type TooltipProps,
} from 'recharts';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from './ui/chart';
import type { PromptTrendItem } from '@aiusage/shared';
import type { Locale } from '../i18n';
import { getChartColors } from '../constants';
import { formatCompact, formatNumber, shortDate, longDate } from '../utils/format';
import { ChartLegend, EmptyState } from './chart-helpers';
import { useIsDark } from '../hooks/use-dark';

type SeriesKey = 'messageCount' | 'charCount';

export function PromptTrendChart({
  data,
  dates,
  locale,
  labels,
}: {
  data: PromptTrendItem[];
  /** Dates of the selected range, so days without prompts render as zero */
  dates: string[];
  locale: Locale;
  labels: Record<SeriesKey, string>;
}) {
  const isDark = useIsDark();

  const rows = useMemo(() => {
    const byDate = new Map(data.map(d => [d.usageDate, d]));
    const allDates = [...new Set([...dates, ...byDate.keys()])].sort();
    return allDates.map(usageDate => ({
      usageDate,
      messageCount: byDate.get(usageDate)?.messageCount ?? 0,
      charCount: byDate.get(usageDate)?.charCount ?? 0,
    }));
  }, [data, dates]);

  if (!data.length) return <EmptyState label="No data" />;

  // Message count is the light backdrop (left axis), characters the dark foreground (right axis)
  const colors = getChartColors(isDark);
  const messageColor = colors[isDark ? 3 : 4];
  const charColor = colors[0];
  const config = {
    messageCount: { label: labels.messageCount, color: messageColor },
    charCount: { label: labels.charCount, color: charColor },
  } satisfies ChartConfig;
  const totals = rows.reduce(
    (sum, row) => ({ messageCount: sum.messageCount + row.messageCount, charCount: sum.charCount + row.charCount }),
    { messageCount: 0, charCount: 0 },
  );
  // Headroom keeps the message line in the lower band and lets characters fill the top
  const messageAxis = axisScale(Math.max(...rows.map(r => r.messageCount)) * 2);
  const charAxis = axisScale(Math.max(...rows.map(r => r.charCount)) * 1.1);
  const axisProps = {
    tickLine: false, axisLine: false, tickMargin: 8, allowDecimals: false,
    tickFormatter: (v: number) => formatCompact(Number(v), locale),
    className: 'fill-slate-400 dark:fill-slate-500', fontSize: 11,
  };

  return (
    <>
      <ChartContainer config={config} className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* Same plot box and band scale as the cost bar chart, so each point sits over its bar */}
          <ComposedChart data={rows} margin={{ top: 12, left: 4, right: 12, bottom: 0 }}>
            <defs>
              <linearGradient id="prompt-fill-messages" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={messageColor} stopOpacity={0.45} />
                <stop offset="100%" stopColor={messageColor} stopOpacity={0.08} />
              </linearGradient>
              <linearGradient id="prompt-fill-chars" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={charColor} stopOpacity={0.32} />
                <stop offset="100%" stopColor={charColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-white/[0.06]" />
            <XAxis
              dataKey="usageDate" tickLine={false} axisLine={false}
              tickMargin={12} tickFormatter={shortDate} minTickGap={36}
              className="fill-slate-400 dark:fill-slate-500" fontSize={11}
            />
            <YAxis yAxisId="messages" orientation="left" width={48} {...messageAxis} {...axisProps} />
            <YAxis yAxisId="chars" orientation="right" width={1} mirror {...charAxis} {...axisProps} />
            <ChartTooltip
              cursor={{ stroke: isDark ? '#334155' : '#e2e8f0' }}
              content={({ active, label, payload }: TooltipProps<number, string>) => (
                <ChartTooltipContent
                  active={active}
                  label={label}
                  // Drop the invisible layout bars (tooltipType="none")
                  payload={payload?.filter(item => item.type !== 'none')}
                  labelFormatter={longDate}
                  formatter={(v) => formatNumber(Number(v))}
                />
              )}
            />
            {/* Invisible bars give the x axis the cost chart's band layout: ticks and points at band centers */}
            <Bar yAxisId="chars" dataKey="charCount" fill="transparent" tooltipType="none" legendType="none" isAnimationActive={false} />
            <Area
              yAxisId="messages" dataKey="messageCount" type="monotone"
              stroke={messageColor} strokeWidth={1.4} fill="url(#prompt-fill-messages)"
              isAnimationActive={false}
            />
            <Area
              yAxisId="chars" dataKey="charCount" type="monotone"
              stroke={charColor} strokeWidth={1.8} fill="url(#prompt-fill-chars)"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>
      <ChartLegend
        items={[
          { label: `${labels.messageCount} ←`, color: messageColor, value: formatNumber(totals.messageCount) },
          { label: `${labels.charCount} →`, color: charColor, value: formatNumber(totals.charCount) },
        ]}
      />
    </>
  );
}

const AXIS_INTERVALS = 4;

// Domain and evenly spaced ticks whose step is 1/2/2.5/3/4/5/6/8 × 10^n
function axisScale(top: number): { domain: [number, number]; ticks: number[] } {
  const raw = Math.max(top, 1) / AXIS_INTERVALS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 3, 4, 5, 6, 8, 10].find(f => f * magnitude >= raw) ?? 10) * magnitude;
  const max = step * AXIS_INTERVALS;
  return { domain: [0, max], ticks: Array.from({ length: AXIS_INTERVALS + 1 }, (_, i) => i * step) };
}
