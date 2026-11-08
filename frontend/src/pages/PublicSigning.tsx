// =============================================================================
// /firmar/:token — the customer signs its installation documents remotely
// =============================================================================
// No session: the token in the link the ISP sent is the credential
// (GET /api/v1/public/signing/:token, POST .../documents/:id/sign). Mobile
// first. Each pending document is read in full and signed with a drawn
// signature, the signer's name and an explicit acceptance; the first
// handoff document (the activation contract) also records the optional
// communication choices against the privacy notice, as on site. The contract
// waits until the technician's visit has started.
// =============================================================================

import { lazy, Suspense, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { SignatureCanvas } from '@/components/SignatureCanvas';
import {
  CommunicationOptInFields,
  type CommunicationContacts,
  type CommunicationOptIns,
  type SigningPrivacyNotice,
} from '@/components/CommunicationOptInFields';
import { MxSandboxDocumentBanner, type MxContractEnvironment } from '@/components/MxContractEnvironment';
import { LoadingState } from '@/components/FetchStates';

const MarkdownView = lazy(() => import('@/components/MarkdownView'));

interface PublicDocument {
  id: number;
  template_type: string;
  title: string;
  status: 'pending' | 'signed';
  signed_at: string | null;
  mx_contract_environment: MxContractEnvironment | null;
  rendered_body: string | null;
  signable: boolean;
  waiting_for_visit: boolean;
  captures_communication_choices: boolean;
}

interface SigningPage {
  organization_name: string | null;
  customer_first_name: string;
  expires_at: string;
  documents: PublicDocument[];
  communication_contacts: CommunicationContacts;
  privacy_notice: SigningPrivacyNotice | null;
}

class SigningError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message); }
}

async function readBody<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (!res.ok) throw new SigningError(res.status, body?.error?.code ?? null, body?.error?.message ?? `HTTP ${res.status}`);
  return body?.data as T;
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function fetchSigningPage(token: string): Promise<SigningPage> {
  return readBody<SigningPage>(await fetch(`/api/v1/public/signing/${token}`, { credentials: 'omit', headers: { Accept: 'application/json' } }));
}

async function signDocument(token: string, documentId: number, body: Record<string, unknown>): Promise<unknown> {
  return readBody(await fetch(`/api/v1/public/signing/${token}/documents/${documentId}/sign`, {
    method: 'POST', credentials: 'omit', headers: JSON_HEADERS, body: JSON.stringify(body),
  }));
}

const card = {
  border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 12, padding: 16, background: 'var(--bg-card, #fff)',
} as const;

function LinkProblem({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const code = error instanceof SigningError ? error.code : null;
  const key = code === 'LINK_EXPIRED' ? 'expired'
    : code === 'LINK_REVOKED' ? 'revoked'
      : code === 'LINK_COMPLETED' ? 'completed'
        : error instanceof SigningError && error.status === 404 ? 'notFound' : 'loadError';
  return (
    <div style={card} role="alert">
      <h1 style={{ fontSize: '1.2rem', margin: '0 0 8px' }}>{t(`publicSigning.problem.${key}.title`)}</h1>
      <p style={{ margin: 0 }}>{t(`publicSigning.problem.${key}.body`)}</p>
    </div>
  );
}

function SignForm({ token, doc, page, onSigned }: { token: string; doc: PublicDocument; page: SigningPage; onSigned: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [optIns, setOptIns] = useState<CommunicationOptIns>({ email: false, sms: false, whatsapp: false });
  const [choicesConfirmed, setChoicesConfirmed] = useState(false);
  const [error, setError] = useState('');
  const needsChoices = doc.captures_communication_choices;

  const sign = useMutation({
    mutationFn: () => signDocument(token, doc.id, {
      signer_name: name.trim(),
      signature_image: signature,
      accept: accepted,
      ...(needsChoices && page.privacy_notice ? {
        communication_opt_ins: optIns,
        communication_choices_confirmed: choicesConfirmed,
        privacy_notice_version: page.privacy_notice.version,
        privacy_notice_hash: page.privacy_notice.hash,
      } : {}),
    }),
    onSuccess: onSigned,
    onError: (err: unknown) => setError(err instanceof SigningError && err.status < 500 ? err.message : t('publicSigning.signError')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (name.trim().length < 2) { setError(t('publicSigning.nameRequired')); return; }
    if (!signature) { setError(t('publicSigning.signatureRequired')); return; }
    if (needsChoices && !choicesConfirmed) { setError(t('publicSigning.choicesRequired')); return; }
    if (!accepted) { setError(t('publicSigning.acceptRequired')); return; }
    sign.mutate();
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <MxSandboxDocumentBanner environment={doc.mx_contract_environment} />
      <div style={{ border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 8, padding: 12, maxHeight: '55vh', overflowY: 'auto', background: 'var(--bg-subtle, #f9fafb)' }}>
        <Suspense fallback={<LoadingState />}>
          <MarkdownView markdown={doc.rendered_body ?? ''} />
        </Suspense>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {t('publicSigning.name')}
        <input value={name} onChange={e => setName(e.target.value)} maxLength={200} autoComplete="name" style={{ padding: 10, fontSize: '1rem', borderRadius: 8, border: '1px solid var(--border-color, #d1d5db)' }} />
      </label>
      <div>
        <div style={{ marginBottom: 4 }}>{t('publicSigning.signHere')}</div>
        <SignatureCanvas onChange={setSignature} />
      </div>
      {needsChoices && (
        <CommunicationOptInFields
          contacts={page.communication_contacts}
          privacyNotice={page.privacy_notice}
          value={optIns}
          onChange={setOptIns}
          confirmed={choicesConfirmed}
          onConfirmedChange={setChoicesConfirmed}
          disabled={sign.isPending}
        />
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} style={{ marginTop: 4 }} />
        <span>{t('publicSigning.accept')}</span>
      </label>
      {error && <p role="alert" style={{ color: 'var(--danger, #b91c1c)', margin: 0 }}>{error}</p>}
      <button type="submit" disabled={sign.isPending} style={{ padding: 14, fontSize: '1rem', fontWeight: 600, borderRadius: 10, border: 'none', background: 'var(--accent, #2563eb)', color: '#fff' }}>
        {sign.isPending ? t('publicSigning.signing') : t('publicSigning.sign')}
      </button>
    </form>
  );
}

export default function PublicSigning() {
  const { t } = useTranslation();
  const { token = '' } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [justSigned, setJustSigned] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['public-signing', token],
    queryFn: () => fetchSigningPage(token),
    retry: false,
  });

  const page = q.data;
  const pending = page?.documents.filter(d => d.status === 'pending') ?? [];

  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '16px 16px 48px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg-page, #fff)', minHeight: '100vh' }}>
      {q.isLoading && <LoadingState />}
      {q.isError && !justSigned && <LinkProblem error={q.error} />}
      {q.isError && justSigned && (
        <div style={card} role="status">
          <h1 style={{ fontSize: '1.2rem', margin: '0 0 8px' }}>{t('publicSigning.allDone.title')}</h1>
          <p style={{ margin: 0 }}>{t('publicSigning.allDone.body')}</p>
        </div>
      )}
      {page && (
        <>
          <header>
            <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.9rem' }}>{page.organization_name}</div>
            <h1 style={{ fontSize: '1.4rem', margin: '4px 0' }}>
              {page.customer_first_name ? t('publicSigning.hello', { name: page.customer_first_name }) : t('publicSigning.helloNoName')}
            </h1>
            <p style={{ margin: 0 }}>{t('publicSigning.intro')}</p>
          </header>
          {justSigned && <p role="status" style={{ ...card, background: 'var(--success-soft, #ecfdf5)', margin: 0 }}>{t('publicSigning.signed', { title: justSigned })}</p>}
          {pending.length === 0 && (
            <div style={card}><strong>{t('publicSigning.allDone.title')}</strong><p style={{ margin: '6px 0 0' }}>{t('publicSigning.allDone.body')}</p></div>
          )}
          {page.documents.map(doc => (
            <section key={doc.id} style={card} aria-label={doc.title}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{doc.title}</h2>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: doc.status === 'signed' ? 'var(--success, #047857)' : 'var(--text-secondary, #6b7280)' }}>
                  {doc.status === 'signed' ? t('publicSigning.status.signed') : doc.waiting_for_visit ? t('publicSigning.status.waiting') : t('publicSigning.status.pending')}
                </span>
              </div>
              {doc.waiting_for_visit && <p style={{ margin: '8px 0 0' }}>{t('publicSigning.waitingHelp')}</p>}
              {doc.signable && open !== doc.id && (
                <button type="button" onClick={() => setOpen(doc.id)} style={{ marginTop: 12, padding: 12, width: '100%', fontSize: '1rem', borderRadius: 10, border: '1px solid var(--accent, #2563eb)', background: 'transparent', color: 'var(--accent, #2563eb)', fontWeight: 600 }}>
                  {t('publicSigning.readAndSign')}
                </button>
              )}
              {doc.signable && open === doc.id && (
                <SignForm
                  token={token}
                  doc={doc}
                  page={page}
                  onSigned={() => { setJustSigned(doc.title); setOpen(null); void queryClient.invalidateQueries({ queryKey: ['public-signing', token] }); }}
                />
              )}
            </section>
          ))}
          <p style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '0.85rem' }}>{t('publicSigning.footer')}</p>
        </>
      )}
    </main>
  );
}
