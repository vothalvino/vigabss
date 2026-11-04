// =============================================================================
// VigaBSS 5.0 — Device / Network Map
// =============================================================================
// Shows the ISP's physical/logical network topology:
//   • Sites section — site cards with devices grouped under each site
//   • SNMP status badge per device (online / offline / maintenance + SNMP indicator)
//   • Network Links table — device-to-device connections with type, capacity, status
//   • "Unassigned" group for devices not linked to any site
// All data fetched from:
//   GET /api/v1/sites          — site list
//   GET /api/v1/devices        — device list (with site_id)
//   GET /api/v1/network-links  — link list (device_a_id, device_b_id)
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, tokenStore, authedFetch } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import {
  extractApiError,
  overlay,
  modalBox,
  errorBox,
  labelStyle,
  inputStyle,
  twoCol,
  submitBtn,
  cancelBtn,
  dangerBtn,
} from '@/components/ClientFormModal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Site {
  id: number;
  name: string;
  site_type: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  status: string;
  latitude: number | null;
  longitude: number | null;
}

export interface Device {
  id: number;
  site_id: number | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  type: string;
  manufacturer: string | null;
  model: string | null;
  ip_address: string | null;
  status: string;
  snmp_enabled: boolean | number;
  /** Write-only: the API returns has_snmp_community instead of the value. */
  has_snmp_community?: boolean;
  has_snmp_trap_community?: boolean;
  snmp_version?: string | null;
  snmp_v3_security_name?: string | null;
  snmp_v3_auth_protocol?: string | null;
  snmp_v3_priv_protocol?: string | null;
  /** Write-only keys: the API returns these flags instead (NET-31). */
  has_snmp_v3_auth_key?: boolean;
  has_snmp_v3_priv_key?: boolean;
  snmp_port?: number | null;
  snmp_profile_id?: number | null;
  deleted_at?: string | null;
  serial_number?: string | null;
  mac_address?: string | null;
}

interface NetworkLink {
  id: number;
  device_a_id: number;
  device_b_id: number;
  link_type: string;
  capacity_mbps: number | null;
  interface_a: string | null;
  interface_b: string | null;
  status: string;
}

interface ListResponse<T> {
  data: T[];
  meta?: { total: number; page: number; limit: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const API_BASE = '/api/v1';

async function fetchAll<T>(path: string, query = ''): Promise<T[]> {
  const token = tokenStore.getAccess();
  const res = await authedFetch(`${API_BASE}${path}?limit=1000${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  const json = (await res.json()) as ListResponse<T>;
  return json.data;
}

async function fetchSites(): Promise<Site[]> {
  return fetchAll<Site>('/sites');
}

async function fetchDevices(includeDeleted = false): Promise<Device[]> {
  return fetchAll<Device>('/devices', includeDeleted ? '&include_deleted=true' : '');
}

async function fetchLinks(): Promise<NetworkLink[]> {
  return fetchAll<NetworkLink>('/network-links');
}

// ---------------------------------------------------------------------------
// Status badge helpers
// ---------------------------------------------------------------------------

function DeviceStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    online:      { bg: '#d1fae5', color: '#065f46' },
    offline:     { bg: '#fee2e2', color: '#991b1b' },
    maintenance: { bg: '#fef9c3', color: '#854d0e' },
  };
  const s = map[status] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: '1px 7px', borderRadius: 10,
      fontSize: '0.7rem', fontWeight: 600, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  );
}

function SiteStatusDot({ status }: { status: string }) {
  const color = status === 'active' ? '#22c55e' : status === 'inactive' ? '#f87171' : '#fbbf24';
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, marginRight: 5, verticalAlign: 'middle',
    }} />
  );
}

function LinkStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string }> = {
    active:         { bg: '#d1fae5', color: '#065f46' },
    down:           { bg: '#fee2e2', color: '#991b1b' },
    maintenance:    { bg: '#fef9c3', color: '#854d0e' },
    decommissioned: { bg: '#f3f4f6', color: '#9ca3af' },
  };
  const s = map[status] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{
      background: s.bg, color: s.color,
      padding: '2px 8px', borderRadius: 12,
      fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize',
    }}>
      {status}
    </span>
  );
}

const DEVICE_ICON: Record<string, string> = {
  router:      '🔀',
  switch:      '🔄',
  olt:         '💡',
  onu:         '🔌',
  ptp:         '📡',
  ptmp_ap:     '📶',
  outdoor_cpe: '🛰️',
  indoor_cpe:  '📺',
  other:       '🖧',
};

function deviceIcon(type: string): string {
  return DEVICE_ICON[type] ?? '🖧';
}

// ---------------------------------------------------------------------------
// Device chip — compact card for a device inside a site
// ---------------------------------------------------------------------------

interface DeviceChipActions {
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (d: Device) => void;
  onDelete: (d: Device) => void;
  onRestore: (d: Device) => void;
}

function DeviceChip({ device, actions }: { device: Device; actions?: DeviceChipActions }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const archived = Boolean(device.deleted_at);
  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '8px 10px',
        background: archived ? '#f9fafb' : hovered ? '#f0f4ff' : '#fff',
        opacity: archived ? 0.7 : 1,
        cursor: 'default',
        minWidth: 160,
        transition: 'background .15s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: 3 }}>
        {deviceIcon(device.type)}&nbsp;
        <Link to={`/devices/${device.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
          {device.name}
        </Link>
      </div>
      <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: 3 }}>
        {device.manufacturer ? `${device.manufacturer} ` : ''}
        {device.model ?? device.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </div>
      {device.ip_address && (
        <div style={{ fontSize: '0.72rem', color: '#6b7280', fontFamily: 'monospace', marginBottom: 4 }}>
          {device.ip_address}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {archived ? (
          <span style={{
            background: '#f3f4f6', color: '#6b7280',
            padding: '1px 7px', borderRadius: 10, fontSize: '0.68rem', fontWeight: 600,
          }}>
            {t('ui.deviceMap.archived')}
          </span>
        ) : (
          <DeviceStatusBadge status={device.status} />
        )}
        {(device.snmp_enabled === true || device.snmp_enabled === 1) && (
          <span style={{
            background: '#ede9fe', color: '#5b21b6',
            padding: '1px 7px', borderRadius: 10,
            fontSize: '0.68rem', fontWeight: 600,
          }}>
            SNMP
          </span>
        )}
      </div>
      {actions && (actions.canEdit || actions.canDelete) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {archived ? (
            actions.canEdit && (
              <button type="button" style={chipBtn} onClick={() => actions.onRestore(device)}>{t('ui.deviceMap.restore')}</button>
            )
          ) : (
            <>
              {actions.canEdit && (
                <button type="button" style={chipBtn} onClick={() => actions.onEdit(device)}>{t('ui.deviceMap.edit')}</button>
              )}
              {actions.canDelete && (
                <button type="button" style={chipDangerBtn} onClick={() => actions.onDelete(device)}>{t('ui.deviceMap.archive')}</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site card — shows site info + its devices
// ---------------------------------------------------------------------------

interface SiteCardProps {
  site: Site;
  devices: Device[];
  actions?: DeviceChipActions;
}

function SiteCard({ site, devices, actions }: SiteCardProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={{
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      background: '#fff',
      boxShadow: '0 0 0 1px var(--border)',
      overflow: 'hidden',
    }}>
      {/* Site header */}
      <div
        style={{
          background: '#f9fafb',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid #e5e7eb',
        }}
        onClick={() => setCollapsed(c => !c)}
      >
        <div>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', marginRight: 6 }}>
            <SiteStatusDot status={site.status} />
            {site.id > 0 ? (
              <Link to={`/sites/${site.id}`} style={{ color: 'inherit', textDecoration: 'none', fontWeight: 700 }}>
                {site.name}
              </Link>
            ) : site.name}
          </span>
          {site.site_type && (
            <span style={{ fontSize: '0.73rem', color: '#6b7280' }}>
              ({site.site_type})
            </span>
          )}
          {(site.city || site.state) && (
            <span style={{ fontSize: '0.73rem', color: '#9ca3af', marginLeft: 8 }}>
              📍 {[site.city, site.state].filter(Boolean).join(', ')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
            {devices.length} {t('ui.deviceMap.device')}{devices.length !== 1 ? 's' : ''}
          </span>
          <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>

      {/* Device chips */}
      {!collapsed && (
        <div style={{ padding: 12 }}>
          {devices.length === 0 ? (
            <p style={{ margin: 0, color: '#9ca3af', fontSize: '0.8rem', fontStyle: 'italic' }}>
              {t('ui.deviceMap.noDevicesAssignedToThis')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {devices.map(d => <DeviceChip key={d.id} device={d} actions={actions} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network Links Table
// ---------------------------------------------------------------------------

interface LinksTableProps {
  links: NetworkLink[];
  deviceMap: Map<number, Device>;
}

function LinksTable({ links, deviceMap }: LinksTableProps) {
  const { t } = useTranslation();
  function devLabel(id: number): string {
    const d = deviceMap.get(id);
    return d ? d.name : `#${id}`;
  }

  const LINK_TYPE_COLOR: Record<string, string> = {
    fiber:    'var(--link)',
    wireless: '#059669',
    copper:   '#b45309',
    virtual:  '#7c3aed',
    other:    '#6b7280',
  };

  return (
    <div style={{ overflowX: 'auto', marginTop: '1.5rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.75rem' }}>{t('ui.deviceMap.networkLinks')}</h2>
      {links.length === 0 ? (
        <p style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: '0.85rem' }}>{t('ui.deviceMap.noNetworkLinksDefined')}</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={th}>{t('ui.deviceMap.deviceA')}</th>
              <th style={th}>{t('ui.deviceMap.interfaceA')}</th>
              <th style={th}>{t('ui.deviceMap.deviceB')}</th>
              <th style={th}>{t('ui.deviceMap.interfaceB')}</th>
              <th style={th}>{t('ui.deviceMap.type')}</th>
              <th style={th}>{t('ui.deviceMap.capacity')}</th>
              <th style={th}>{t('ui.deviceMap.status')}</th>
            </tr>
          </thead>
          <tbody>
            {links.map(l => (
              <tr key={l.id}>
                <td style={td}>{l.id}</td>
                <td style={{ ...td, fontWeight: 500 }}>{devLabel(l.device_a_id)}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{l.interface_a ?? '—'}</td>
                <td style={{ ...td, fontWeight: 500 }}>{devLabel(l.device_b_id)}</td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{l.interface_b ?? '—'}</td>
                <td style={td}>
                  <span style={{
                    background: '#f3f4f6', color: LINK_TYPE_COLOR[l.link_type] ?? '#374151',
                    padding: '2px 7px', borderRadius: 10, fontSize: '0.72rem', fontWeight: 600,
                    textTransform: 'capitalize',
                  }}>
                    {l.link_type}
                  </span>
                </td>
                <td style={td}>{l.capacity_mbps ? `${l.capacity_mbps} Mbps` : '—'}</td>
                <td style={td}><LinkStatusBadge status={l.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

interface SummaryBarProps {
  sites: Site[];
  devices: Device[];
  links: NetworkLink[];
}

function SummaryBar({ sites, devices, links }: SummaryBarProps) {
  const online = devices.filter(d => d.status === 'online').length;
  const offline = devices.filter(d => d.status === 'offline').length;
  const snmpEnabled = devices.filter(d => d.snmp_enabled === true || d.snmp_enabled === 1).length;
  const activeLinks = links.filter(l => l.status === 'active').length;

  const stat = (label: string, value: string | number, color?: string) => (
    <div style={{
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 8,
      padding: '10px 16px',
      minWidth: 120,
    }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: color ?? '#111' }}>{value}</div>
      <div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: 1 }}>{label}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: '1.5rem' }}>
      {stat('Sites', sites.length)}
      {stat('Devices', devices.length)}
      {stat('Online', online, '#059669')}
      {stat('Offline', offline, offline > 0 ? '#dc2626' : '#059669')}
      {stat('SNMP Monitored', snmpEnabled, '#7c3aed')}
      {stat('Active Links', activeLinks)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device create/edit modal
// ---------------------------------------------------------------------------

// MUST mirror the backend enums exactly (schemas/devices.js ↔ devices table).
// The previous lists ('ap'/'antenna'/'server'/'cpe' types; 'active'/'inactive'/
// 'decommissioned' statuses) matched NEITHER — and since the form always sends
// status (defaulting to the invalid 'active'), EVERY create from this modal
// failed with "Validation failed".
const DEVICE_TYPES: { value: string; label: string }[] = [
  { value: 'outdoor_cpe', label: 'Outdoor CPE' },
  { value: 'indoor_cpe', label: 'Indoor CPE' },
  { value: 'ptp', label: 'PtP link' },
  { value: 'ptmp_ap', label: 'PtMP AP' },
  { value: 'olt', label: 'OLT' },
  { value: 'router', label: 'Router' },
  { value: 'switch', label: 'Switch' },
  { value: 'onu', label: 'ONU' },
  { value: 'other', label: 'Other' },
];
const DEVICE_STATUSES = ['online', 'offline', 'maintenance'];

interface DeviceFormProps {
  mode: 'create' | 'edit';
  device?: Device;
  sites: Site[];
  onClose: () => void;
  onSaved: () => void;
}

export function DeviceFormModal({ mode, device, sites, onClose, onSaved }: DeviceFormProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: device?.name ?? '',
    type: device?.type ?? 'router',
    status: device?.status ?? 'offline',
    site_id: device?.site_id != null ? String(device.site_id) : '',
    manufacturer: device?.manufacturer ?? '',
    model: device?.model ?? '',
    serial_number: device?.serial_number ?? '',
    mac_address: device?.mac_address ?? '',
    ip_address: device?.ip_address ?? '',
    snmp_enabled: Boolean(device?.snmp_enabled),
    snmp_community: '',
    snmp_trap_community: '',
    snmp_version: device?.snmp_version ?? 'v2c',
    snmp_v3_security_name: device?.snmp_v3_security_name ?? '',
    snmp_v3_auth_protocol: device?.snmp_v3_auth_protocol ?? 'sha',
    snmp_v3_auth_key: '',
    snmp_v3_priv_protocol: device?.snmp_v3_priv_protocol ?? 'aes128',
    snmp_v3_priv_key: '',
    snmp_port: device?.snmp_port != null ? String(device.snmp_port) : '161',
    snmp_profile_id: device?.snmp_profile_id != null ? String(device.snmp_profile_id) : '',
    latitude: device?.latitude != null ? String(device.latitude) : '',
    longitude: device?.longitude != null ? String(device.longitude) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // SNMP profiles decide WHAT gets recorded (each profile is an OID→metric
  // list, incl. the per-model CPE templates seeded by migration 413).
  const profilesQ = useQuery({
    queryKey: ['snmp-profiles-for-device-form'],
    queryFn: async () => {
      const res = await api.GET('/snmp-profiles', { params: { query: { limit: 100 } } });
      if ((res as { error?: unknown }).error) return [] as { id: number; name: string }[];
      return (((res as unknown as { data: { data: { id: number; name: string }[] } }).data?.data) ?? []);
    },
  });

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    const body: Record<string, string | number | boolean> = {
      name: form.name.trim(),
      type: form.type,
      status: form.status,
    };
    if (form.site_id) body.site_id = Number(form.site_id);
    (['manufacturer', 'model', 'serial_number', 'mac_address', 'ip_address'] as const).forEach(k => {
      const v = form[k].trim();
      if (v) body[k] = v;
    });
    // Map pin (j68): explicit-clear-vs-omit — a blanked coordinate on edit
    // clears the pin; untouched-empty on create is simply omitted.
    (['latitude', 'longitude'] as const).forEach(k => {
      const v = form[k].trim();
      if (v !== '') {
        (body as Record<string, unknown>)[k] = Number(v);
      } else if (mode === 'edit' && device?.[k] != null) {
        (body as Record<string, unknown>)[k] = null;
      }
    });
    body.snmp_enabled = form.snmp_enabled;
    if (form.snmp_enabled) {
      body.snmp_version = form.snmp_version;
      if (form.snmp_community.trim()) body.snmp_community = form.snmp_community.trim();
      if (form.snmp_trap_community.trim()) body.snmp_trap_community = form.snmp_trap_community.trim();
      if (form.snmp_version === 'v3') {
        // Keys are write-only: blank keeps the stored (encrypted) key.
        const v3 = body as Record<string, unknown>;
        v3.snmp_v3_security_name = form.snmp_v3_security_name.trim();
        v3.snmp_v3_auth_protocol = form.snmp_v3_auth_protocol;
        v3.snmp_v3_priv_protocol = form.snmp_v3_priv_protocol;
        if (form.snmp_v3_auth_key) v3.snmp_v3_auth_key = form.snmp_v3_auth_key;
        if (form.snmp_v3_priv_key) v3.snmp_v3_priv_key = form.snmp_v3_priv_key;
      }
      if (form.snmp_port) body.snmp_port = Number(form.snmp_port);
      if (form.snmp_profile_id) body.snmp_profile_id = Number(form.snmp_profile_id);
    }

    const { error: apiError } = mode === 'create'
      ? await api.POST('/devices', { body: body })
      : await api.PUT('/devices/{id}', { params: { path: { id: device!.id } }, body: body });

    setSaving(false);
    if (apiError) { setError(extractApiError(apiError, 'Failed to save device.')); return; }
    onSaved();
  }

  const title = mode === 'create' ? 'New Device' : `Edit ${device?.name ?? 'Device'}`;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div style={{ ...modalBox, width: 540, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem' }}>{title}</h3>
        {error && <div style={errorBox}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>{t('ui.deviceMap.name')}</label>
          <input style={inputStyle} type="text" value={form.name} onChange={set('name')} required autoFocus />

          <div style={twoCol}>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.type')}</label>
              <select style={inputStyle} value={form.type} onChange={set('type')}>
                {DEVICE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.status')}</label>
              <select style={inputStyle} value={form.status} onChange={set('status')}>
                {DEVICE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <label style={labelStyle}>{t('ui.deviceMap.site')}</label>
          <select style={inputStyle} value={form.site_id} onChange={set('site_id')}>
            <option value="">{t('ui.deviceMap.unassigned')}</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>

          <div style={twoCol}>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.manufacturer')}</label>
              <input style={inputStyle} type="text" value={form.manufacturer} onChange={set('manufacturer')} />
            </div>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.model')}</label>
              <input style={inputStyle} type="text" value={form.model} onChange={set('model')} />
            </div>
          </div>

          <div style={twoCol}>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.macAddress')}</label>
              <input style={inputStyle} type="text" value={form.mac_address} onChange={set('mac_address')} maxLength={17} />
            </div>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.ipAddress')}</label>
              <input style={inputStyle} type="text" value={form.ip_address} onChange={set('ip_address')} maxLength={45} />
            </div>
          </div>

          <div style={twoCol}>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.latitude')}</label>
              <input style={inputStyle} type="number" step="0.0000001" min={-90} max={90}
                placeholder="19.4326" value={form.latitude} onChange={set('latitude')} />
            </div>
            <div>
              <label style={labelStyle}>{t('ui.deviceMap.longitude')}</label>
              <input style={inputStyle} type="number" step="0.0000001" min={-180} max={180}
                placeholder="-99.1332" value={form.longitude} onChange={set('longitude')} />
            </div>
          </div>

          <label style={labelStyle}>{t('ui.deviceMap.serialNumber')}</label>
          <input style={inputStyle} type="text" value={form.serial_number} onChange={set('serial_number')} maxLength={100} />

          {/* SNMP monitoring — the profile decides WHAT metrics get recorded */}
          <div style={{ borderTop: '1px solid var(--border-color, #e5e7eb)', marginTop: '1rem', paddingTop: '0.75rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.snmp_enabled}
                onChange={e => setForm(f => ({ ...f, snmp_enabled: e.target.checked }))}
              />
              {t('ui.deviceMap.snmpMonitoring')}
            </label>
            {form.snmp_enabled && (
              <div style={{ marginTop: 8 }}>
                <div style={twoCol}>
                  <div>
                    <label style={labelStyle}>{t('ui.deviceMap.version')}</label>
                    <select style={inputStyle} value={form.snmp_version} onChange={set('snmp_version')}>
                      <option value="v1">v1</option>
                      <option value="v2c">v2c</option>
                      <option value="v3">v3</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>{t('ui.deviceMap.port')}</label>
                    <input style={inputStyle} type="number" min={1} max={65535} value={form.snmp_port} onChange={set('snmp_port')} />
                  </div>
                </div>
                <label style={labelStyle}>{t('ui.deviceMap.community')}</label>
                <input style={inputStyle} type="password" autoComplete="new-password" value={form.snmp_community} onChange={set('snmp_community')} maxLength={96} placeholder={device?.has_snmp_community ? 'Leave blank to keep the current community' : 'public'} />
                <label style={labelStyle} htmlFor="device-trap-community">{t('deviceForm.trapCommunity')}</label>
                <input id="device-trap-community" style={inputStyle} type="password" autoComplete="new-password" value={form.snmp_trap_community} onChange={set('snmp_trap_community')} maxLength={96} placeholder={device?.has_snmp_trap_community ? t('deviceForm.trapCommunityKeep') : ''} aria-describedby="device-trap-community-hint" />
                <div id="device-trap-community-hint" style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>{t('deviceForm.trapCommunityHint')}</div>
                {form.snmp_version === 'v3' && (
                  <div>
                    <label style={labelStyle} htmlFor="device-v3-user">{t('deviceForm.snmpV3.securityName')}</label>
                    <input id="device-v3-user" style={inputStyle} value={form.snmp_v3_security_name} onChange={set('snmp_v3_security_name')} maxLength={255} />
                    <div style={twoCol}>
                      <div>
                        <label style={labelStyle} htmlFor="device-v3-auth-proto">{t('deviceForm.snmpV3.authProtocol')}</label>
                        <select id="device-v3-auth-proto" style={inputStyle} value={form.snmp_v3_auth_protocol} onChange={set('snmp_v3_auth_protocol')}>
                          {['none', 'md5', 'sha', 'sha256', 'sha512'].map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle} htmlFor="device-v3-auth-key">{t('deviceForm.snmpV3.authKey')}</label>
                        <input id="device-v3-auth-key" style={inputStyle} type="password" autoComplete="new-password" maxLength={128} value={form.snmp_v3_auth_key} onChange={set('snmp_v3_auth_key')} placeholder={device?.has_snmp_v3_auth_key ? t('deviceForm.snmpV3.keepKey') : ''} />
                      </div>
                    </div>
                    <div style={twoCol}>
                      <div>
                        <label style={labelStyle} htmlFor="device-v3-priv-proto">{t('deviceForm.snmpV3.privProtocol')}</label>
                        <select id="device-v3-priv-proto" style={inputStyle} value={form.snmp_v3_priv_protocol} onChange={set('snmp_v3_priv_protocol')}>
                          {['none', 'des', 'aes128', 'aes256'].map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle} htmlFor="device-v3-priv-key">{t('deviceForm.snmpV3.privKey')}</label>
                        <input id="device-v3-priv-key" style={inputStyle} type="password" autoComplete="new-password" maxLength={128} value={form.snmp_v3_priv_key} onChange={set('snmp_v3_priv_key')} placeholder={device?.has_snmp_v3_priv_key ? t('deviceForm.snmpV3.keepKey') : ''} />
                      </div>
                    </div>
                  </div>
                )}
                <label style={labelStyle}>{t('ui.deviceMap.profileWhatToRecord')}</label>
                <select style={inputStyle} value={form.snmp_profile_id} onChange={set('snmp_profile_id')}>
                  <option value="">{t('ui.deviceMap.noProfileNotPolled')}</option>
                  {(profilesQ.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted, #6b7280)', margin: '4px 0 0' }}>
                  {t('ui.deviceMap.theProfileIsTheOid')}
                </p>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: '1.25rem' }}>
            <button type="button" style={cancelBtn} onClick={onClose} disabled={saving}>{t('ui.deviceMap.cancel')}</button>
            <button type="submit" style={submitBtn} disabled={saving}>{saving ? 'Saving…' : (mode === 'create' ? 'Create Device' : 'Save Changes')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete device confirmation modal
// ---------------------------------------------------------------------------

function DeleteDeviceModal({
  device,
  onClose,
  onDeleted,
}: {
  device: Device;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleDelete() {
    setSaving(true);
    setError(null);
    const { error: apiError } = await api.DELETE('/devices/{id}', {
      params: { path: { id: device.id } },
    });
    setSaving(false);
    if (apiError) { setError(extractApiError(apiError, 'Failed to archive device.')); return; }
    onDeleted();
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.deviceMap.archiveDevice')}>
      <div style={modalBox}>
        <h3 style={{ margin: '0 0 1rem' }}>{t('ui.deviceMap.archiveDevice2')}</h3>
        {error && <div style={errorBox}>{error}</div>}
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
          {t('ui.deviceMap.archive2')}<strong>{device.name}</strong>{t('ui.deviceMap.itCanBeRestoredLater')}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: '1.25rem' }}>
          <button type="button" style={cancelBtn} onClick={onClose} disabled={saving}>{t('ui.deviceMap.cancel')}</button>
          <button type="button" style={dangerBtn} onClick={handleDelete} disabled={saving}>{saving ? 'Archiving…' : 'Archive'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function DeviceMap() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [siteFilter, setSiteFilter] = useState('');
  const [deviceStatusFilter, setDeviceStatusFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [formTarget, setFormTarget] = useState<{ mode: 'create' | 'edit'; device?: Device } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canCreate = can(user, 'devices.create');
  const canEditDevice = can(user, 'devices.update');
  const canDeleteDevice = can(user, 'devices.delete');

  const sitesQuery = useQuery({ queryKey: ['sites'], queryFn: fetchSites });
  const devicesQuery = useQuery({
    queryKey: ['devices-all', showArchived],
    queryFn: () => fetchDevices(showArchived),
  });
  const linksQuery = useQuery({ queryKey: ['network-links'], queryFn: fetchLinks });

  const refreshDevices = () => queryClient.invalidateQueries({ queryKey: ['devices-all'] });

  async function handleRestore(device: Device) {
    setActionError(null);
    const { error: apiError } = await api.POST('/devices/{id}/restore', {
      params: { path: { id: device.id } },
    });
    if (apiError) { setActionError(extractApiError(apiError, 'Failed to restore device.')); return; }
    refreshDevices();
  }

  const deviceActions: DeviceChipActions = {
    canEdit: canEditDevice,
    canDelete: canDeleteDevice,
    onEdit: (d) => setFormTarget({ mode: 'edit', device: d }),
    onDelete: (d) => setDeleteTarget(d),
    onRestore: handleRestore,
  };

  const isLoading = sitesQuery.isLoading || devicesQuery.isLoading || linksQuery.isLoading;
  const error = sitesQuery.error ?? devicesQuery.error ?? linksQuery.error;

  const allSites: Site[] = sitesQuery.data ?? [];
  const allDevices: Device[] = devicesQuery.data ?? [];
  const allLinks: NetworkLink[] = linksQuery.data ?? [];

  // Filtered sites
  const sites = allSites.filter(s =>
    !siteFilter || s.name.toLowerCase().includes(siteFilter.toLowerCase()),
  );

  // Filtered devices
  const devices = allDevices.filter(d =>
    !deviceStatusFilter || d.status === deviceStatusFilter,
  );

  const deviceMap = new Map<number, Device>(allDevices.map(d => [d.id, d]));

  // Group devices by site
  const devicesBySite = new Map<number | null, Device[]>();
  devices.forEach(d => {
    const key = d.site_id ?? null;
    if (!devicesBySite.has(key)) devicesBySite.set(key, []);
    devicesBySite.get(key)!.push(d);
  });

  const unassigned = devicesBySite.get(null) ?? [];

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{t('ui.deviceMap.deviceNetworkMap')}</h1>
        {canCreate && (
          <button style={btnPrimary} onClick={() => setFormTarget({ mode: 'create' })}>
            {t('ui.deviceMap.newDevice')}
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={filterInput}
          placeholder={t('ui.deviceMap.filterSitesByName')}
          value={siteFilter}
          onChange={e => setSiteFilter(e.target.value)}
        />
        <select
          style={filterSelect}
          value={deviceStatusFilter}
          onChange={e => setDeviceStatusFilter(e.target.value)}
        >
          <option value="">{t('ui.deviceMap.allDeviceStatuses')}</option>
          <option value="active">{t('ui.deviceMap.active')}</option>
          <option value="inactive">{t('ui.deviceMap.inactive')}</option>
          <option value="maintenance">{t('ui.deviceMap.maintenance')}</option>
          <option value="decommissioned">{t('ui.deviceMap.decommissioned')}</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', color: '#6b7280', cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          {t('ui.deviceMap.showArchived')}
        </label>
        {(siteFilter || deviceStatusFilter) && (
          <button style={btnSecondary} onClick={() => { setSiteFilter(''); setDeviceStatusFilter(''); }}>
            {t('ui.deviceMap.clear')}
          </button>
        )}
      </div>

      {actionError && <p style={{ color: '#e00', fontSize: '0.85rem' }}>{actionError}</p>}

      {isLoading && <p style={{ color: '#888' }}>{t('ui.deviceMap.loadingNetworkMap')}</p>}
      {error && <p style={{ color: '#e00' }}>{t('ui.deviceMap.failedToLoadNetworkData')}</p>}

      {!isLoading && !error && (
        <>
          {/* Summary bar */}
          <SummaryBar sites={allSites} devices={allDevices} links={allLinks} />

          {/* Sites + their devices */}
          <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: '0 0 0.75rem' }}>{t('ui.deviceMap.sites')}</h2>
          {sites.length === 0 && !siteFilter && (
            <p style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: '0.85rem' }}>{t('ui.deviceMap.noSitesDefined')}</p>
          )}
          {sites.length === 0 && siteFilter && (
            <p style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: '0.85rem' }}>{t('ui.deviceMap.noSitesMatch')}{siteFilter}".</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sites.map(site => (
              <SiteCard
                key={site.id}
                site={site}
                devices={devicesBySite.get(site.id) ?? []}
                actions={deviceActions}
              />
            ))}
          </div>

          {/* Unassigned devices */}
          {unassigned.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <SiteCard
                site={{
                  id: -1,
                  name: 'Unassigned',
                  site_type: null,
                  address: null,
                  city: null,
                  state: null,
                  status: 'active',
                  latitude: null,
                  longitude: null,
                }}
                devices={unassigned}
                actions={deviceActions}
              />
            </div>
          )}

          {/* Network links */}
          <LinksTable links={allLinks} deviceMap={deviceMap} />
        </>
      )}

      {/* Modals */}
      {formTarget && (
        <DeviceFormModal
          mode={formTarget.mode}
          device={formTarget.device}
          sites={allSites}
          onClose={() => setFormTarget(null)}
          onSaved={() => { setFormTarget(null); refreshDevices(); }}
        />
      )}
      {deleteTarget && (
        <DeleteDeviceModal
          device={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); refreshDevices(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const filterInput: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db',
  fontSize: '0.85rem', background: '#fff', minWidth: 200,
};
const filterSelect: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db',
  fontSize: '0.85rem', background: '#fff',
};
const btnSecondary: React.CSSProperties = {
  background: '#fff', color: '#374151', border: '1px solid #d1d5db',
  padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
};
const btnPrimary: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  padding: '7px 16px', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
};
const chipBtn: React.CSSProperties = {
  background: '#fff', color: '#374151', border: '1px solid #d1d5db',
  padding: '2px 8px', borderRadius: 6, cursor: 'pointer', fontSize: '0.7rem',
};
const chipDangerBtn: React.CSSProperties = {
  background: '#fff', color: '#dc2626', border: '1px solid #fecaca',
  padding: '2px 8px', borderRadius: 6, cursor: 'pointer', fontSize: '0.7rem',
};
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', background: '#fff',
  borderRadius: 8, overflow: 'hidden',
  boxShadow: '0 0 0 1px var(--border)',
};
const th: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: '0.78rem',
  fontWeight: 700, color: '#555', background: '#f9fafb',
  borderBottom: '1px solid #e5e7eb',
};
const td: React.CSSProperties = {
  padding: '10px 12px', fontSize: '0.85rem', color: '#374151',
  borderBottom: '1px solid #f3f4f6',
};
