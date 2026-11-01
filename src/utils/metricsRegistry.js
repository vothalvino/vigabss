'use strict';

// =============================================================================
// Prometheus metrics registry (OPS-15, DB-13)
// =============================================================================
// The /metrics endpoint used to keep the last N latency samples per series and
// rebuild a histogram from them on every scrape. That had two faults: the
// bucket loop re-summed already-cumulative counts (le=10 read 11x the request
// count while +Inf read 1x), and a sliding window made _bucket and _count go
// down, which rate() reads as counter resets. Here a histogram keeps one
// monotonic counter per bucket, a counter only increases, and both cap their
// label combinations so a client cannot grow memory without bound (OPS-01).
// =============================================================================

const OVERFLOW = '__other__';

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelString(names, values) {
  return names.map((n, i) => `${n}="${escapeLabel(values[i])}"`).join(',');
}

class Series {
  constructor(labelNames, maxSeries) {
    this.labelNames = labelNames;
    this.maxSeries = maxSeries;
    this.map = new Map();
  }

  // Past the cap, new combinations collapse into one overflow series.
  key(labels) {
    let values = this.labelNames.map((n) => (labels[n] === undefined ? '' : String(labels[n])));
    let key = values.join('\u0000');
    if (!this.map.has(key) && this.map.size >= this.maxSeries) {
      values = this.labelNames.map(() => OVERFLOW);
      key = values.join('\u0000');
    }
    return { key, values };
  }
}

class Counter {
  constructor({ name, help, labelNames = [], maxSeries = 500 }) {
    Object.assign(this, { name, help, type: 'counter' });
    this.series = new Series(labelNames, maxSeries);
  }

  inc(labels = {}, n = 1) {
    const { key, values } = this.series.key(labels);
    const entry = this.series.map.get(key);
    if (entry) entry.value += n;
    else this.series.map.set(key, { values, value: n });
  }

  get(labels = {}) {
    return this.series.map.get(this.series.key(labels).key)?.value || 0;
  }

  reset() { this.series.map.clear(); }

  lines() {
    const names = this.series.labelNames;
    return [...this.series.map.values()].map(({ values, value }) => (
      names.length ? `${this.name}{${labelString(names, values)}} ${value}` : `${this.name} ${value}`
    ));
  }
}

class Histogram {
  constructor({ name, help, labelNames = [], buckets, maxSeries = 500 }) {
    Object.assign(this, { name, help, type: 'histogram' });
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.series = new Series(labelNames, maxSeries);
  }

  observe(labels, value) {
    const { key, values } = this.series.key(labels);
    let entry = this.series.map.get(key);
    if (!entry) {
      entry = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.map.set(key, entry);
    }
    // One counter per bucket: the first bucket the value fits. Cumulative
    // totals are summed at render time, so every exported line only grows.
    const idx = this.buckets.findIndex((b) => value <= b);
    if (idx !== -1) entry.counts[idx] += 1;
    entry.sum += value;
    entry.count += 1;
  }

  reset() { this.series.map.clear(); }

  lines() {
    const out = [];
    const names = this.series.labelNames;
    for (const { values, counts, sum, count } of this.series.map.values()) {
      const base = names.length ? `${labelString(names, values)},` : '';
      const plain = names.length ? `{${labelString(names, values)}}` : '';
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += counts[i];
        out.push(`${this.name}_bucket{${base}le="${b}"} ${cumulative}`);
      });
      out.push(`${this.name}_bucket{${base}le="+Inf"} ${count}`);
      out.push(`${this.name}_sum${plain} ${sum.toFixed(6)}`);
      out.push(`${this.name}_count${plain} ${count}`);
    }
    return out;
  }
}

// A value read at scrape time. `collect` returns a number, or an array of
// { labels, value } for a labelled gauge or a counter kept elsewhere.
class Collected {
  constructor({ name, help, type = 'gauge', collect }) {
    Object.assign(this, { name, help, type, collect });
  }

  lines() {
    let result;
    try { result = this.collect(); } catch { return []; }
    if (result === null || result === undefined) return [];
    if (!Array.isArray(result)) return Number.isFinite(result) ? [`${this.name} ${result}`] : [];
    return result
      .filter((r) => Number.isFinite(r.value))
      .map(({ labels = {}, value }) => {
        const names = Object.keys(labels);
        return names.length
          ? `${this.name}{${labelString(names, names.map((n) => labels[n]))}} ${value}`
          : `${this.name} ${value}`;
      });
  }
}

class Registry {
  constructor() { this.metrics = new Map(); }

  register(metric) {
    if (this.metrics.has(metric.name)) return this.metrics.get(metric.name);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(opts) { return this.register(new Counter(opts)); }

  histogram(opts) { return this.register(new Histogram(opts)); }

  collected(opts) { return this.register(new Collected(opts)); }

  names() { return [...this.metrics.keys()]; }

  render() {
    const lines = [];
    for (const m of this.metrics.values()) {
      lines.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`, ...m.lines());
    }
    return `${lines.join('\n')}\n`;
  }
}

const registry = new Registry();

module.exports = { registry, Registry, Counter, Histogram, Collected, OVERFLOW };
