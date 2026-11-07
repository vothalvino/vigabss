// =============================================================================
// Reseller app (/punto) — Nuevo cliente
// =============================================================================
// A reseller signs up a neighbour as a lead (POST /reseller-app/leads); the
// ISP converts it, signs the contract and installs. The server sets the
// organization, the reseller and the source. After saving, the page runs the
// coverage desk check (GET /reseller-app/leads/:id/feasibility) and shows a
// plain summary of it.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { CODIGO_POSTAL_PATTERN, REGIMEN_FISCAL_OPTIONS, RFC_PATTERN } from '@/lib/regimenFiscal';
import {
  createPuntoLead, fetchPuntoFeasibility, fetchPuntoPlans, puntoKeys,
  type PuntoFeasibility, type PuntoLead, type PuntoLeadBody,
} from './puntoApi';
import { errorText, mutedText, pageTitle, usePuntoCurrency } from './puntoUi';

interface FormState {
  name: string; phone: string; email: string; address: string; city: string;
  desired_plan_id: string; rfc: string; razon_social: string; regimen_fiscal: string;
  codigo_postal_fiscal: string; notes: string;
}

const EMPTY: FormState = {
  name: '', phone: '', email: '', address: '', city: '', desired_plan_id: '', rfc: '',
  razon_social: '', regimen_fiscal: '', codigo_postal_fiscal: '', notes: '',
};

type GeoState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'found'; latitude: number; longitude: number }
  | { kind: 'error'; messageKey: string };

const OPTIONAL_TEXT = ['email', 'address', 'city', 'rfc', 'razon_social', 'regimen_fiscal', 'codigo_postal_fiscal', 'notes'] as const;

/** The request body: required fields trimmed, blank optional ones left out. */
export function buildLeadBody(form: FormState, geo: GeoState): PuntoLeadBody {
  const body: PuntoLeadBody = { name: form.name.trim(), phone: form.phone.trim() };
  for (const key of OPTIONAL_TEXT) {
    const value = form[key].trim();
    if (value) body[key] = key === 'rfc' ? value.toUpperCase() : value;
  }
  if (form.desired_plan_id) body.desired_plan_id = Number(form.desired_plan_id);
  if (geo.kind === 'found') {
    body.latitude = geo.latitude;
    body.longitude = geo.longitude;
  }
  return body;
}

const BAND_KEYS = {
  under_1km: 'punto.newClient.feasibility.bandUnder1',
  under_3km: 'punto.newClient.feasibility.bandUnder3',
} as const;

/**
 * The server's coverage summary in plain words. "Covered" means inside a
 * zone that is in service; "nearby" means an antenna or fiber box within
 * 3 km. Anything else is the "no coverage found" message: the company
 * reviews the case before promising service.
 */
function FeasibilitySummary({ lead }: { lead: PuntoLead }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: puntoKeys.feasibility(lead.id),
    queryFn: () => fetchPuntoFeasibility(lead.id),
    retry: false,
  });

  if (q.isLoading) return <p style={mutedText} role="status">{t('punto.newClient.feasibility.checking')}</p>;
  if (q.isError || !q.data) return <p style={mutedText}>{t('punto.newClient.feasibility.error')}</p>;
  const f: PuntoFeasibility = q.data;
  if (!f.has_coordinates) return <p style={mutedText}>{t('punto.newClient.feasibility.noLocation')}</p>;

  const zones = f.coverage_zones;
  const wireless = f.wireless.nearby && f.wireless.distance_band && f.wireless.distance_band !== 'farther'
    ? f.wireless.distance_band : null;
  const fiber = f.ftth.nearby && f.ftth.distance_band && f.ftth.distance_band !== 'farther'
    ? f.ftth.distance_band : null;
  const disclaimer = <p style={{ ...mutedText, marginTop: 6, fontSize: '0.78rem' }}>{t('punto.newClient.feasibility.disclaimer')}</p>;

  if (!f.covered && !wireless && !fiber) {
    return (
      <div>
        <p style={{ margin: 0 }}>{t('punto.newClient.feasibility.none')}</p>
        {f.zone_lookup_failed && <p style={{ ...mutedText, marginTop: 6 }}>{t('punto.newClient.feasibility.zonesUnavailable')}</p>}
        {disclaimer}
      </div>
    );
  }
  const fiberPorts = f.ftth.has_free_ports === true
    ? t('punto.newClient.feasibility.fiberFree')
    : f.ftth.has_free_ports === false ? t('punto.newClient.feasibility.fiberFull') : '';
  return (
    <div>
      <p style={{ margin: '0 0 6px', fontWeight: 700, color: f.covered ? 'var(--success)' : undefined }}>
        {f.covered ? t('punto.newClient.feasibility.covered') : t('punto.newClient.feasibility.nearby')}
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.9rem' }}>
        {zones.length > 0 && <li>{t('punto.newClient.feasibility.zones', { names: zones.map(z => z.name).join(', ') })}</li>}
        {wireless && <li>{t('punto.newClient.feasibility.wireless', { distance: t(BAND_KEYS[wireless]) })}</li>}
        {fiber && <li>{`${t('punto.newClient.feasibility.fiber', { distance: t(BAND_KEYS[fiber]) })}${fiberPorts ? ` ${fiberPorts}` : ''}`}</li>}
      </ul>
      {disclaimer}
    </div>
  );
}

/** POST /reseller-app/leads needs reseller_app.signup; without it, go home. */
export function PuntoNewClient() {
  const { user } = useAuth();
  if (!can(user, 'reseller_app.signup')) return <Navigate to="/punto" replace />;
  return <PuntoNewClientForm />;
}

function PuntoNewClientForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const currency = usePuntoCurrency();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [geo, setGeo] = useState<GeoState>({ kind: 'idle' });
  const [showFiscal, setShowFiscal] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<PuntoLead | null>(null);

  const plans = useQuery({ queryKey: puntoKeys.plans, queryFn: fetchPuntoPlans });

  const save = useMutation({
    mutationFn: createPuntoLead,
    onSuccess: (lead) => {
      setCreated(lead);
      void qc.invalidateQueries({ queryKey: ['punto'] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t('punto.newClient.saveError')),
  });

  const set = (key: keyof FormState) => (e: { target: { value: string } }) => setForm(p => ({ ...p, [key]: e.target.value }));

  function locate() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo({ kind: 'error', messageKey: 'punto.newClient.location.unsupported' });
      return;
    }
    setGeo({ kind: 'locating' });
    navigator.geolocation.getCurrentPosition(
      pos => setGeo({
        kind: 'found',
        latitude: Number(pos.coords.latitude.toFixed(6)),
        longitude: Number(pos.coords.longitude.toFixed(6)),
      }),
      err => setGeo({
        kind: 'error',
        messageKey: err.code === 1 ? 'punto.newClient.location.denied' : 'punto.newClient.location.failed',
      }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.phone.trim()) { setError(t('punto.newClient.required')); return; }
    const rfc = form.rfc.trim().toUpperCase();
    if (rfc && !RFC_PATTERN.test(rfc)) { setShowFiscal(true); setError(t('punto.newClient.invalidRfc')); return; }
    const cp = form.codigo_postal_fiscal.trim();
    if (cp && !CODIGO_POSTAL_PATTERN.test(cp)) { setShowFiscal(true); setError(t('punto.newClient.invalidCp')); return; }
    save.mutate(buildLeadBody(form, geo));
  }

  function reset() {
    setForm(EMPTY);
    setGeo({ kind: 'idle' });
    setShowFiscal(false);
    setError('');
    setCreated(null);
  }

  if (created) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="punto-card" role="status">
          <h1 style={{ ...pageTitle, color: 'var(--success)' }}>{t('punto.newClient.done.title')}</h1>
          <p style={{ margin: 0 }}>{t('punto.newClient.done.body', { name: created.name })}</p>
        </div>
        <section className="punto-card" aria-labelledby="punto-feasibility">
          <h2 id="punto-feasibility" style={{ margin: '0 0 8px', fontSize: '1rem' }}>{t('punto.newClient.feasibility.title')}</h2>
          <FeasibilitySummary lead={created} />
        </section>
        <Link to="/punto/prospectos" className="punto-btn-primary">{t('punto.newClient.done.viewLeads')}</Link>
        <button type="button" className="punto-btn-secondary" onClick={reset}>{t('punto.newClient.done.another')}</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h1 style={pageTitle}>{t('punto.newClient.title')}</h1>
      <p style={{ ...mutedText, marginBottom: 12 }}>{t('punto.newClient.intro')}</p>
      {error && <p role="alert" style={errorText}>{error}</p>}

      <div className="punto-field">
        <label htmlFor="pn-name">{t('punto.newClient.name')} *</label>
        <input id="pn-name" autoComplete="name" required maxLength={200} value={form.name} onChange={set('name')} />
      </div>
      <div className="punto-field">
        <label htmlFor="pn-phone">{t('punto.newClient.phone')} *</label>
        <input id="pn-phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={30} value={form.phone} onChange={set('phone')} />
      </div>
      <div className="punto-field">
        <label htmlFor="pn-email">{t('punto.newClient.email')}</label>
        <input id="pn-email" type="email" inputMode="email" autoComplete="email" maxLength={255} value={form.email} onChange={set('email')} />
      </div>
      <div className="punto-field">
        <label htmlFor="pn-address">{t('punto.newClient.address')}</label>
        <input id="pn-address" autoComplete="street-address" maxLength={500} value={form.address} onChange={set('address')} />
      </div>
      <div className="punto-field">
        <label htmlFor="pn-city">{t('punto.newClient.city')}</label>
        <input id="pn-city" autoComplete="address-level2" maxLength={100} value={form.city} onChange={set('city')} />
      </div>

      <div className="punto-card" style={{ marginBottom: 12 }}>
        <button type="button" className="punto-btn-secondary" style={{ width: '100%' }} onClick={locate} disabled={geo.kind === 'locating'}>
          {geo.kind === 'locating' ? t('punto.newClient.location.locating') : t('punto.newClient.location.use')}
        </button>
        {geo.kind === 'found' && (
          <p style={{ ...mutedText, marginTop: 8 }}>
            {t('punto.newClient.location.found', { latitude: geo.latitude, longitude: geo.longitude })}{' '}
            <button type="button" onClick={() => setGeo({ kind: 'idle' })} style={{ background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', padding: 0 }}>
              {t('punto.newClient.location.clear')}
            </button>
          </p>
        )}
        {geo.kind === 'error' && <p role="alert" style={{ ...mutedText, marginTop: 8, color: 'var(--warning)' }}>{t(geo.messageKey)}</p>}
        {geo.kind === 'idle' && <p style={{ ...mutedText, marginTop: 8, fontSize: '0.78rem' }}>{t('punto.newClient.location.hint')}</p>}
      </div>

      <div className="punto-field">
        <label htmlFor="pn-plan">{t('punto.newClient.plan')}</label>
        <select id="pn-plan" value={form.desired_plan_id} onChange={set('desired_plan_id')} disabled={plans.isLoading}>
          <option value="">{plans.isLoading ? t('punto.common.loading') : t('punto.newClient.planNone')}</option>
          {(plans.data ?? []).map(p => (
            <option key={p.id} value={p.id}>
              {t('punto.newClient.planOption', {
                name: p.name,
                price: formatMoney(p.price, currency),
                speed: p.download_speed ? t('punto.newClient.planSpeed', { down: p.download_speed, up: p.upload_speed ?? '—' }) : '',
              }).trim()}
            </option>
          ))}
        </select>
        {plans.isError && <span style={{ ...mutedText, color: 'var(--warning)' }}>{t('punto.newClient.plansError')}</span>}
      </div>

      <div className="punto-card" style={{ marginBottom: 12 }}>
        <button
          type="button"
          aria-expanded={showFiscal}
          aria-controls="pn-fiscal"
          onClick={() => setShowFiscal(v => !v)}
          style={{ background: 'none', border: 'none', padding: 0, width: '100%', textAlign: 'left', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.95rem' }}
        >
          {showFiscal ? '▾' : '▸'} {t('punto.newClient.fiscal.title')}
        </button>
        {showFiscal && (
          <div id="pn-fiscal" style={{ marginTop: 10 }}>
            <p style={{ ...mutedText, marginBottom: 10, fontSize: '0.78rem' }}>{t('punto.newClient.fiscal.hint')}</p>
            <div className="punto-field">
              <label htmlFor="pn-rfc">{t('punto.newClient.fiscal.rfc')}</label>
              <input id="pn-rfc" maxLength={13} autoCapitalize="characters" value={form.rfc}
                onChange={e => setForm(p => ({ ...p, rfc: e.target.value.toUpperCase() }))} />
            </div>
            <div className="punto-field">
              <label htmlFor="pn-razon">{t('punto.newClient.fiscal.razonSocial')}</label>
              <input id="pn-razon" maxLength={254} value={form.razon_social} onChange={set('razon_social')} />
            </div>
            <div className="punto-field">
              <label htmlFor="pn-regimen">{t('punto.newClient.fiscal.regimen')}</label>
              <select id="pn-regimen" value={form.regimen_fiscal} onChange={set('regimen_fiscal')}>
                <option value="">{t('punto.newClient.fiscal.regimenNone')}</option>
                {REGIMEN_FISCAL_OPTIONS.map(r => <option key={r.code} value={r.code}>{`${r.code} — ${r.description}`}</option>)}
              </select>
            </div>
            <div className="punto-field" style={{ marginBottom: 0 }}>
              <label htmlFor="pn-cp">{t('punto.newClient.fiscal.cp')}</label>
              <input id="pn-cp" inputMode="numeric" maxLength={5} value={form.codigo_postal_fiscal} onChange={set('codigo_postal_fiscal')} />
            </div>
          </div>
        )}
      </div>

      <div className="punto-field">
        <label htmlFor="pn-notes">{t('punto.newClient.notes')}</label>
        <textarea id="pn-notes" rows={3} value={form.notes} onChange={set('notes')} />
      </div>

      <button type="submit" className="punto-btn-primary" disabled={save.isPending}>
        {save.isPending ? t('punto.newClient.saving') : t('punto.newClient.submit')}
      </button>
    </form>
  );
}
