// =============================================================================
// VigaBSS 5.0 — Operations Console
// =============================================================================
// The operations overview dashboard (replaces the former AdminDashboard at "/").
// A single dense screen: KPI row, network throughput, live events, sites/POPs,
// and a filterable device table — built on the VigaBSS UI kit + design tokens.
//
// Data gate: while the system is empty (no real clients yet) the console shows
// the design's polished DEMO numbers so a fresh install looks alive. Once the
// first client exists it auto-switches to live /dashboard/* + /alerts/events
// data mapped into the same view-model. See consoleModel.ts.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useWebSocket } from '@/api/useWebSocket';
import { useOrgCurrency } from '@/auth/useOrgCurrency';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { Button, Badge, Field } from '@/components/ui';
import {
  resolveModel, buildChart, buildChartFromSeries, isDemoInstall, type Range,
  type SummaryData, type MrrRow, type DeviceHealthData, type OverdueInvoice, type AlertEvent,
  type ThroughputSeries, type ChartModel, type SessionsData, type SiteRow, type DeviceRow,
} from './operations-console/consoleModel';
import { KpiRow, ThroughputChart, LiveEvents, SitesStrip, DeviceTable, type DeviceFilter } from './operations-console/consoleWidgets';
import { canOpenConsoleRoute } from './operations-console/consoleAccess';
import './operations-console/console.css';

// ---------------------------------------------------------------------------
// Fetch helpers — typed api client (auth + silent-refresh middleware)
// ---------------------------------------------------------------------------

async function fetchSummary(): Promise<SummaryData> {
  const res = await api.GET('/dashboard/summary');
  if (res.error) throw new Error('Failed to load summary');
  return (res.data as unknown as { data: SummaryData }).data;
}
async function fetchMrr(): Promise<MrrRow[]> {
  const res = await api.GET('/dashboard/mrr');
  if (res.error) throw new Error('Failed to load MRR');
  return (res.data as unknown as { data: MrrRow[] }).data;
}
async function fetchDeviceHealth(): Promise<DeviceHealthData> {
  const res = await api.GET('/dashboard/device-health');
  if (res.error) throw new Error('Failed to load device health');
  return (res.data as unknown as { data: DeviceHealthData }).data;
}
async function fetchOverdue(): Promise<OverdueInvoice[]> {
  const res = await api.GET('/dashboard/overdue');
  if (res.error) throw new Error('Failed to load overdue invoices');
  return (res.data as unknown as { data: OverdueInvoice[] }).data;
}
// Events are best-effort: a missing endpoint or a role without devices.view must
// not break the console — fall back to an empty feed.
async function fetchEvents(): Promise<AlertEvent[]> {
  try {
    const res = await api.GET('/alerts/events' as never, { params: { query: { limit: 12 } as never } } as never) as { error?: unknown; data?: unknown };
    if (res.error) return [];
    const d = (res.data as { data?: unknown })?.data;
    return Array.isArray(d) ? (d as AlertEvent[]) : [];
  } catch {
    return [];
  }
}

// Real network throughput from SNMP interface counters. Best-effort: returns
// null on error/malformed payload so the console shows an empty state.
async function fetchThroughput(range: Range): Promise<ThroughputSeries | null> {
  try {
    const res = await api.GET('/dashboard/throughput' as never, { params: { query: { range } as never } } as never) as { error?: unknown; data?: unknown };
    if (res.error) return null;
    const d = (res.data as { data?: ThroughputSeries })?.data;
    return d && Array.isArray(d.points) ? d : null;
  } catch {
    return null;
  }
}

// Live RADIUS session count. React Query requires a concrete result; null is
// the honest best-effort empty state and the view model maps it to a placeholder.
async function fetchSessions(): Promise<SessionsData | null> {
  try {
    const res = await api.GET('/dashboard/live-sessions' as never, {} as never) as { error?: unknown; data?: unknown };
    if (res.error) return null;
    const d = (res.data as { data?: SessionsData })?.data;
    return d && typeof d.value === 'string' ? d : null;
  } catch {
    return null;
  }
}

// Per-site device-health for the Sites & POPs strip. Best-effort → [].
async function fetchSites(): Promise<SiteRow[]> {
  try {
    const res = await api.GET('/dashboard/sites-utilization' as never, {} as never) as { error?: unknown; data?: unknown };
    if (res.error) return [];
    const d = (res.data as { data?: unknown })?.data;
    return Array.isArray(d) ? (d as SiteRow[]) : [];
  } catch {
    return [];
  }
}

// Per-device operational feed for the Network Devices table. Best-effort → [].
async function fetchNetworkDevices(): Promise<DeviceRow[]> {
  try {
    const res = await api.GET('/dashboard/network-devices' as never, {} as never) as { error?: unknown; data?: unknown };
    if (res.error) return [];
    const d = (res.data as { data?: unknown })?.data;
    return Array.isArray(d) ? (d as DeviceRow[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OperationsConsole() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();

  // Live-data queries (auto-refresh keeps the "live" feel once real).
  const summaryQ = useQuery({ queryKey: ['dashboard-summary'], queryFn: fetchSummary, refetchInterval: 30_000 });
  const mrrQ = useQuery({ queryKey: ['dashboard-mrr'], queryFn: fetchMrr, refetchInterval: 60_000 });
  const healthQ = useQuery({ queryKey: ['dashboard-device-health'], queryFn: fetchDeviceHealth, refetchInterval: 60_000 });
  const overdueQ = useQuery({ queryKey: ['dashboard-overdue'], queryFn: fetchOverdue, refetchInterval: 60_000 });
  const eventsQ = useQuery({ queryKey: ['alerts-events'], queryFn: fetchEvents, refetchInterval: 30_000 });

  // These panels fetch unless this is a demo install (the summary says there
  // are no clients yet); a summary the user cannot read is not a demo (FE-08).
  const isReal = !isDemoInstall(summaryQ.data);
  const sessionsQ = useQuery({ queryKey: ['dashboard-live-sessions'], queryFn: fetchSessions, refetchInterval: 30_000, enabled: isReal });
  const sitesQ = useQuery({ queryKey: ['dashboard-sites'], queryFn: fetchSites, refetchInterval: 60_000, enabled: isReal });
  const devicesQ = useQuery({ queryKey: ['dashboard-network-devices'], queryFn: fetchNetworkDevices, refetchInterval: 60_000, enabled: isReal });

  // Live notifications → silently refresh KPIs (proven pattern from AdminDashboard).
  const { lastMessage: liveEvent } = useWebSocket('notifications');
  useEffect(() => {
    if (!liveEvent) return;
    const ev = liveEvent.event;
    if (ev === 'invoice' || ev === 'payment' || ev === 'overdue') {
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-overdue'] });
    } else if (ev === 'ticket') {
      void qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
    }
  }, [liveEvent, qc]);

  const orgCurrency = useOrgCurrency();
  const model = useMemo(
    () => resolveModel({
      summary: summaryQ.data,
      mrr: mrrQ.data,
      health: healthQ.data,
      overdue: overdueQ.data,
      events: eventsQ.data,
      sessions: sessionsQ.data ?? undefined,
      sitesData: sitesQ.data,
      devicesData: devicesQ.data,
      orgCurrency,
    }),
    [summaryQ.data, mrrQ.data, healthQ.data, overdueQ.data, eventsQ.data, sessionsQ.data, sitesQ.data, devicesQ.data, orgCurrency],
  );

  // View state
  const [range, setRange] = useState<Range>('24H');
  const [filter, setFilter] = useState<DeviceFilter>('All');
  const [query, setQuery] = useState('');

  // Real network throughput (SNMP) — fetched only once the system has real data;
  // demo mode keeps the synthetic sample.
  const throughputQ = useQuery({
    queryKey: ['dashboard-throughput', range],
    queryFn: () => fetchThroughput(range),
    refetchInterval: 30_000,
    enabled: isReal,
  });


  // Chart: demo → synthetic sample; real → SNMP series, or an honest empty state.
  const chartModel = useMemo<ChartModel | null>(() => {
    if (model.isDemo) return buildChart(7, range);
    if (throughputQ.data?.has_data) return buildChartFromSeries(throughputQ.data);
    return null;
  }, [model.isDemo, throughputQ.data, range]);

  const throughputEmpty = model.isDemo
    ? undefined
    : throughputQ.data?.has_data
      ? undefined
      : throughputQ.isFetched
        ? 'No SNMP throughput telemetry yet — appears once network devices are SNMP-monitored and polled.'
        : 'Loading throughput…';

  const { kpis, events } = model;
  const canCreateTicket = canOpenConsoleRoute(user, '/tickets') && can(user, 'tickets.create');

  // Always the real ticket flow: the demo modal only added a fake event and
  // created nothing (FE-08).
  function onNewTicket() {
    if (!canCreateTicket) return;
    navigate('/tickets');
  }

  return (
    <div className="fi-console" data-screen-label="Operations Console">
      {/* Header */}
      <div className="fi-main-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <h1 className="fi-main-title">Operations Overview</h1>
          <span className="fi-main-sub">Network operations · auto-refresh 30s</span>
        </div>
        {model.isDemo && (
          <Badge tone="warning" style={{ alignSelf: 'center' }}>
            <span title="Sample data — the console switches to live figures once your first client is added.">Demo data</span>
          </Badge>
        )}
        <div className="fi-spacer" />
        {canCreateTicket && <Button onClick={onNewTicket}>New ticket</Button>}
      </div>

      {/* KPI row */}
      <KpiRow kpis={kpis} />

      {/* Throughput + live events */}
      <div className="fi-row">
        <div className="grow"><ThroughputChart range={range} onRange={setRange} chart={chartModel ?? undefined} emptyMessage={throughputEmpty} /></div>
        <div className="side"><LiveEvents events={events} /></div>
      </div>

      {/* Sites & POPs */}
      <SitesStrip sites={model.sites} />

      {/* Devices */}
      <div>
        {/* Search field feeds the device table filter. Global ⌘/Ctrl-K stays
            reserved for the application command palette. */}
        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <Field
            label="Search devices"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, IP, or type…"
            id="fi-device-search"
            style={{ maxWidth: 360 }}
          />
        </div>
        <DeviceTable devices={model.devices} filter={filter} onFilter={setFilter} query={query} />
      </div>
    </div>
  );
}

export default OperationsConsole;
