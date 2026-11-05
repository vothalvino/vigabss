// =============================================================================
// Reports: line chart
// =============================================================================
// Moved out of Reports.tsx, past the 1,500-line page limit (src/test/pageSize.test.ts),
// when its UI text moved into the locale files (FE-07).
// =============================================================================



// ---------------------------------------------------------------------------
// SVG line chart — multi-series
// ---------------------------------------------------------------------------

export interface LineChartProps {
  labels: string[];
  series: { label: string; values: number[]; color: string }[];
  width?: number;
  height?: number;
}

export function LineChart({ labels, series, width = 520, height = 180 }: LineChartProps) {
  const pad = { top: 10, right: 20, bottom: 30, left: 40 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const allVals = series.flatMap(s => s.values);
  const maxV = Math.max(...allVals, 1);
  const n = labels.length;

  function x(i: number) { return pad.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w); }
  function y(v: number) { return pad.top + h - (v / maxV) * h; }
  function polyline(values: number[]) {
    return values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  }

  // x-axis label step to avoid crowding
  const step = Math.ceil(n / 8);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: width, display: 'block' }}>
      {/* axes */}
      <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + h} stroke="#ddd" />
      <line x1={pad.left} y1={pad.top + h} x2={pad.left + w} y2={pad.top + h} stroke="#ddd" />
      {/* y gridlines */}
      {[0.25, 0.5, 0.75, 1].map(t => (
        <g key={t}>
          <line x1={pad.left} y1={pad.top + h - t * h} x2={pad.left + w} y2={pad.top + h - t * h} stroke="#eee" strokeDasharray="3 3" />
          <text x={pad.left - 4} y={pad.top + h - t * h + 4} fontSize={9} textAnchor="end" fill="#999">{Math.round(maxV * t)}</text>
        </g>
      ))}
      {/* x labels */}
      {labels.map((l, i) => i % step === 0 && (
        <text key={i} x={x(i)} y={height - 4} fontSize={9} textAnchor="middle" fill="#999">{l}</text>
      ))}
      {/* series */}
      {series.map(s => (
        <g key={s.label}>
          <polyline points={polyline(s.values)} fill="none" stroke={s.color} strokeWidth={2} />
          {s.values.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color} />
          ))}
        </g>
      ))}
      {/* legend */}
      {series.map((s, si) => (
        <g key={s.label} transform={`translate(${pad.left + si * 120}, ${height - 6})`}>
          <rect width={10} height={10} y={-10} fill={s.color} rx={2} />
          <text x={14} y={0} fontSize={10} fill="#555">{s.label}</text>
        </g>
      ))}
    </svg>
  );
}
