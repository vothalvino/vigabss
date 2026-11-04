// =============================================================================
// Settings: quota bar
// =============================================================================
// Moved out of Settings.tsx, past the 1,500-line page limit (src/test/pageSize.test.ts),
// when its UI text moved into the locale files (FE-07).
// =============================================================================



export function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const isUnlimited = limit === null;
  const pct = (isUnlimited || limit === 0) ? 100 : Math.min(100, Math.round((used / limit!) * 100));
  const color = pct >= 95 ? '#dc2626' : pct >= 80 ? '#d97706' : '#16a34a';
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: '0.875rem' }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span style={{ color: '#555' }}>
          {used.toLocaleString()} / {isUnlimited ? '∞' : limit!.toLocaleString()}
          {!isUnlimited && <span style={{ color: pct >= 95 ? '#dc2626' : '#888', marginLeft: 6 }}>({pct}%)</span>}
        </span>
      </div>
      {!isUnlimited && (
        <div style={{ background: '#f3f4f6', borderRadius: 6, height: 8, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 6, transition: 'width .3s' }} />
        </div>
      )}
    </div>
  );
}
