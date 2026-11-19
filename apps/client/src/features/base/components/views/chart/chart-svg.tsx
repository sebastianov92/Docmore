import { ChartPoint, formatValue, niceMax } from "./chart-data";
import classes from "@/features/base/styles/chart.module.css";

type AxisProps = { points: ChartPoint[]; showValues: boolean; locale: string };

const TOP = 20;
const BOTTOM = 44;
const LEFT = 48;
const RIGHT = 12;
const PLOT_H = 220;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Axes({ width, max, locale, points, slot }: { width: number; max: number; locale: string; points: ChartPoint[]; slot: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const rotate = points.length > 8;
  return (
    <>
      {ticks.map((tk) => {
        const y = TOP + PLOT_H - tk * PLOT_H;
        return (
          <g key={tk}>
            <line x1={LEFT} x2={width - RIGHT} y1={y} y2={y} className={classes.grid} />
            <text x={LEFT - 6} y={y + 4} textAnchor="end" className={classes.axisText}>
              {formatValue(max * tk, locale)}
            </text>
          </g>
        );
      })}
      {points.map((p, i) => {
        const cx = LEFT + i * slot + slot / 2;
        const y = TOP + PLOT_H + 16;
        return (
          <text
            key={p.key}
            x={cx}
            y={y}
            textAnchor={rotate ? "end" : "middle"}
            transform={rotate ? `rotate(-30 ${cx} ${y})` : undefined}
            className={classes.axisText}
          >
            {truncate(p.label, rotate ? 14 : Math.max(6, Math.floor(slot / 7)))}
            <title>{p.label}</title>
          </text>
        );
      })}
    </>
  );
}

export function BarChart({ points, showValues, locale }: AxisProps) {
  const slot = Math.max(40, Math.min(96, Math.floor(640 / Math.max(1, points.length))));
  const width = LEFT + RIGHT + slot * points.length;
  const height = TOP + PLOT_H + BOTTOM;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const barW = Math.round(slot * 0.62);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={classes.svg} role="img">
      <Axes width={width} max={max} locale={locale} points={points} slot={slot} />
      {points.map((p, i) => {
        const v = p.value ?? 0;
        const h = Math.max(v > 0 ? 2 : 0, (v / max) * PLOT_H);
        const x = LEFT + i * slot + (slot - barW) / 2;
        const y = TOP + PLOT_H - h;
        return (
          <g key={p.key} className={classes.mark}>
            <rect x={x} y={y} width={barW} height={h} rx={4} fill={p.color} />
            {showValues && p.value !== null && (
              <text x={x + barW / 2} y={y - 5} textAnchor="middle" className={classes.valueText}>
                {formatValue(p.value, locale)}
              </text>
            )}
            <title>{`${p.label}: ${formatValue(p.value, locale)} (${p.count})`}</title>
          </g>
        );
      })}
    </svg>
  );
}

export function LineChart({ points, showValues, locale }: AxisProps) {
  const slot = Math.max(40, Math.min(96, Math.floor(640 / Math.max(1, points.length))));
  const width = LEFT + RIGHT + slot * points.length;
  const height = TOP + PLOT_H + BOTTOM;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value ?? 0)));
  const coords = points.map((p, i) => ({
    p,
    x: LEFT + i * slot + slot / 2,
    y: TOP + PLOT_H - ((p.value ?? 0) / max) * PLOT_H,
  }));
  const color = points[0]?.color ?? "#228be6";
  const d = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x} ${c.y}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={classes.svg} role="img">
      <Axes width={width} max={max} locale={locale} points={points} slot={slot} />
      {coords.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
      {coords.map(({ p, x, y }) => (
        <g key={p.key} className={classes.mark}>
          <circle cx={x} cy={y} r={4} fill={color} className={classes.ring} />
          {showValues && p.value !== null && (
            <text x={x} y={y - 9} textAnchor="middle" className={classes.valueText}>
              {formatValue(p.value, locale)}
            </text>
          )}
          <title>{`${p.label}: ${formatValue(p.value, locale)} (${p.count})`}</title>
        </g>
      ))}
    </svg>
  );
}

export function PieChart({ points, donut, locale, total }: { points: ChartPoint[]; donut: boolean; locale: string; total: number | null }) {
  const size = 200;
  const r = 92;
  const inner = donut ? 56 : 0;
  const cx = size / 2;
  const cy = size / 2;
  const sum = points.reduce((a, p) => a + Math.max(0, p.value ?? 0), 0);
  let angle = -Math.PI / 2;
  const arcs = points.map((p) => {
    const v = Math.max(0, p.value ?? 0);
    const frac = sum > 0 ? v / sum : 0;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const sx = cx + r * Math.cos(start);
    const sy = cy + r * Math.sin(start);
    const ex = cx + r * Math.cos(end);
    const ey = cy + r * Math.sin(end);
    const isx = cx + inner * Math.cos(end);
    const isy = cy + inner * Math.sin(end);
    const iex = cx + inner * Math.cos(start);
    const iey = cy + inner * Math.sin(start);
    const full = frac >= 0.9999;
    const d = full
      ? `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} ${inner ? `M ${cx + inner} ${cy} A ${inner} ${inner} 0 1 0 ${cx - inner} ${cy} A ${inner} ${inner} 0 1 0 ${cx + inner} ${cy}` : ""} Z`
      : inner
        ? `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} L ${isx} ${isy} A ${inner} ${inner} 0 ${large} 0 ${iex} ${iey} Z`
        : `M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
    return { p, d, frac };
  });
  return (
    <div className={classes.pieWrap}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className={classes.svg} role="img">
        {arcs
          .filter((a) => a.frac > 0)
          .map((a) => (
            <path key={a.p.key} d={a.d} fill={a.p.color} className={`${classes.mark} ${classes.ring}`} fillRule="evenodd">
              <title>{`${a.p.label}: ${formatValue(a.p.value, locale)} (${Math.round(a.frac * 100)}%)`}</title>
            </path>
          ))}
        {donut && (
          <text x={cx} y={cy + 6} textAnchor="middle" className={classes.valueText} style={{ fontSize: 18, fontWeight: 600 }}>
            {formatValue(total, locale)}
          </text>
        )}
      </svg>
      <div className={classes.legend} role="list">
        {points.map((p) => {
          const frac = sum > 0 ? Math.max(0, p.value ?? 0) / sum : 0;
          return (
            <div key={p.key} className={classes.legendRow} role="listitem">
              <span className={classes.dot} style={{ background: p.color }} />
              <span>{p.label}</span>
              <span className={classes.valueText}>{formatValue(p.value, locale)}</span>
              <span className={classes.axisText}>{Math.round(frac * 100)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
