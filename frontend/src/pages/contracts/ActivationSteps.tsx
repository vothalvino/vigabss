// =============================================================================
// Guided first activation — the step model and its small pieces
// =============================================================================
// The activation card on ContractDetail runs five steps in order: schedule the
// visit, test the connection, the customer signs, finish the visit, activate.
// Signing may happen any time after the visit is prepared. This file decides
// which step is current and what to tell the operator next; ContractDetail
// keeps the commands (prepare, test window, speed test, handoff, activate).
// =============================================================================

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelBtn } from '@/components/ClientFormModal';
import { SignedDocumentViewer } from '@/components/SignedDocumentView';

export type ActivationStepStatus = 'done' | 'current' | 'upcoming';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const SERVICE_ORDER_STATUSES = new Set(['pending', 'in_process', 'completed', 'cancelled']);
const WORK_ORDER_STATUSES = new Set(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']);

export function serviceOrderStatusLabel(t: Translate, status: string): string {
  return SERVICE_ORDER_STATUSES.has(status) ? t(`contractActivation.serviceOrderStatus.${status}`) : status;
}

export function workOrderStatusLabel(t: Translate, status: string): string {
  return WORK_ORDER_STATUSES.has(status) ? t(`contractActivation.workOrderStatus.${status}`) : status;
}

/**
 * One step of the guided activation. The current step (and any step that may
 * already be done out of order) shows its controls; a finished step collapses
 * to a one-line summary that can be expanded; a locked step says what unlocks it.
 */
export function ActivationStep({ n, status, title, help, summary, lockedHint, children, last, testId, showWhenLocked, actions, forceOpen }: {
  n: number;
  status: ActivationStepStatus;
  title: string;
  help: string;
  summary: ReactNode;
  /** Shown beside a finished step's summary (e.g. reassigning a technician mid-visit). */
  actions?: ReactNode;
  forceOpen?: boolean;
  lockedHint?: string;
  children: ReactNode;
  last?: boolean;
  testId?: string;
  showWhenLocked?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const open = forceOpen || status === 'current' || (status === 'done' && expanded) || (status === 'upcoming' && showWhenLocked);
  return (
    <div
      style={{ ...stepStyles.step, ...(last ? { borderBottom: 0 } : {}), ...(status === 'upcoming' && !showWhenLocked ? { opacity: 0.6 } : {}) }}
      data-testid={testId}
      data-step-status={status}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={stepStyles.stepTitle}>
          {status === 'done' ? '✓' : `${n}.`} {title}
        </h3>
        {status === 'done' && (
          <button type="button" style={stepStyles.linkBtn} onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
            {expanded ? t('contractActivation.hideDetails') : t('contractActivation.showDetails')}
          </button>
        )}
      </div>
      {status === 'done' && !expanded && !forceOpen && (summary || actions) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {summary && <p style={{ ...stepStyles.done, margin: '0.35rem 0' }}>{summary}</p>}
          {actions}
        </div>
      )}
      {status === 'upcoming' && lockedHint && <p style={stepStyles.help}>{lockedHint}</p>}
      {open && (
        <>
          <p style={stepStyles.help}>{help}</p>
          {children}
        </>
      )}
    </div>
  );
}

export interface ActivationStepInputs {
  workOrderPrepared: boolean;
  needsRecommission: boolean;
  needsDocumentSync: boolean;
  workOrderAssigned: boolean;
  speedTestRecorded: boolean;
  cleanupPending: boolean;
  windowOpen: boolean;
  signatureBlocked: boolean;
  visitCompleted: boolean;
}

/** Which steps are done, which are open now, and the first unfinished one. */
export function activationSteps(input: ActivationStepInputs): {
  stepStatus: (n: number) => ActivationStepStatus;
  currentStep: number;
} {
  const step1 = input.workOrderPrepared && !input.needsRecommission && !input.needsDocumentSync && input.workOrderAssigned;
  const step2 = input.speedTestRecorded && !input.cleanupPending && !input.windowOpen;
  const step3 = !input.signatureBlocked;
  const step4 = input.visitCompleted;
  const done = [step1, step2, step3, step4, false];
  const unlocked = [true, step1, step1, step2 && step3, done.slice(0, 4).every(Boolean)];
  return {
    currentStep: done.findIndex(value => !value) + 1,
    stepStatus: n => (done[n - 1] ? 'done' : unlocked[n - 1] ? 'current' : 'upcoming'),
  };
}

export interface ActivationNextInputs {
  canPrepare: boolean;
  needsRecommission: boolean;
  needsDocumentSync: boolean;
  cleanupPending: boolean;
  cleanupNotice: string;
  arrivalAuthorizationPending: boolean;
  workOrderReadyForTest: boolean;
  windowOpen: boolean;
  systemControlledLine: boolean;
  canActivate: boolean;
}

/** One plain-language sentence: what has to happen next. */
export function activationNextStep(t: Translate, currentStep: number, input: ActivationNextInputs): string {
  if (currentStep === 1) {
    if (!input.canPrepare) return t('contractActivation.next.waitPrepare');
    if (input.needsRecommission) return t('contractActivation.next.recommission');
    if (input.needsDocumentSync) return t('contractActivation.next.syncDocuments');
    return t('contractActivation.next.prepare');
  }
  if (currentStep === 2) {
    if (input.cleanupPending) return input.cleanupNotice;
    if (input.arrivalAuthorizationPending) return t('contractActivation.next.arrival');
    if (!input.workOrderReadyForTest) return t('contractActivation.next.assign');
    if (input.windowOpen) return t('contractActivation.next.recordTest');
    return input.systemControlledLine ? t('contractActivation.next.startTest') : t('contractActivation.next.recordStaticTest');
  }
  if (currentStep === 3) return t('contractActivation.next.sign');
  if (currentStep === 4) return t('contractActivation.next.handoff');
  return input.canActivate ? t('contractActivation.next.activate') : t('contractActivation.next.blocked');
}

export function ActivationStepper({ stepStatus, currentStep, nextStepText, ready, cleanupPending }: {
  stepStatus: (n: number) => ActivationStepStatus;
  currentStep: number;
  nextStepText: string;
  ready: boolean;
  cleanupPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ol style={stepStyles.stepper} aria-label={t('contractActivation.stepsLabel')}>
        {[1, 2, 3, 4, 5].map(n => {
          const status = stepStatus(n);
          return (
            <li
              key={n}
              style={{ ...stepStyles.stepperItem, ...stepStyles.stepperStatus[status], ...(n === currentStep ? stepStyles.stepperCurrent : {}) }}
              aria-current={n === currentStep ? 'step' : undefined}
            >
              <span style={stepStyles.stepperBadge}>{status === 'done' ? '✓' : n}</span>
              {t(`contractActivation.stepShort.s${n}`)}
            </li>
          );
        })}
      </ol>
      <div style={stepStyles.nextStep} role="status">
        <strong>{ready ? t('contractActivation.readyLabel') : t('contractActivation.nextLabel')}</strong>{' '}
        {nextStepText}
        {cleanupPending && (
          <span style={{ display: 'block', marginTop: 4, fontWeight: 400 }}>{t('contractActivation.cleanupWhy')}</span>
        )}
      </div>
    </>
  );
}

/** Cancel the whole activation, after a confirmation. */
export function CancelActivationControl({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" style={{ ...stepStyles.actionBtn, fontSize: '0.78rem' }} onClick={() => setConfirming(true)}>
        {t('contractActivation.cancelActivation')}
      </button>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <span style={{ ...stepStyles.help, margin: 0 }}>{t('contractActivation.cancelActivationConfirm')}</span>
      <button type="button" style={cancelBtn} disabled={pending} onClick={onConfirm}>
        {pending ? t('contractActivation.cancellingActivation') : t('contractActivation.cancelActivation')}
      </button>
      <button type="button" style={stepStyles.actionBtn} onClick={() => setConfirming(false)}>
        {t('contractActivation.keepActivation')}
      </button>
    </div>
  );
}

export function countdown(expiresAt: string, now: number): string {
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function humanizeBlocker(code: string): string {
  return code.replace(/_/g, ' ').replace(/^./, (character: string) => character.toUpperCase());
}

export function ActivationDocumentRow({ document, canSign, onSign }: {
  document: { id: number; title: string; status: string; signer_name?: string | null };
  canSign: boolean;
  onSign: (documentId: number) => void;
}) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState(false);
  return (
    <div style={stepStyles.documentRow}>
      <span style={{ flex: 1 }}>{document.title}</span>
      {document.status === 'signed' ? (
        <>
          <span style={{ color: '#166534' }}>{t('contractActivation.signedBy', { name: document.signer_name ?? '' })}</span>
          <button type="button" style={stepStyles.actionBtn} onClick={() => setViewing(true)}>
            {t('signedDocument.view')}
          </button>
          {viewing && <SignedDocumentViewer documentId={document.id} onClose={() => setViewing(false)} />}
        </>
      ) : document.status === 'pending' ? (
        <>
          <span style={{ color: '#92400e' }}>{t('contractActivation.pendingSignature')}</span>
          {canSign ? (
            <button type="button" style={stepStyles.actionBtn} onClick={() => onSign(document.id)}>
              {t('contractActivation.readAndSign')}
            </button>
          ) : (
            <span style={{ color: 'var(--text-dimmed)', fontSize: '0.76rem' }}>
              {t('contractActivation.signPermissionRequired')}
            </span>
          )}
        </>
      ) : (
        <span style={{ color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{humanizeBlocker(document.status)}</span>
      )}
    </div>
  );
}

const stepStyles = {
  step: { padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' },
  stepTitle: { margin: 0, color: 'var(--text-primary)', fontSize: '1rem' },
  help: { margin: '0.35rem 0 0.6rem', color: 'var(--text-secondary)', fontSize: '0.82rem' },
  done: { color: '#166534', fontWeight: 600, fontSize: '0.85rem', margin: '0.5rem 0 0' },
  linkBtn: { background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' },
  actionBtn: {
    padding: '0.45rem 0.85rem', background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', fontSize: '0.82rem',
    fontWeight: 500, whiteSpace: 'nowrap' as const,
  },
  documentRow: {
    display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.6rem 0.7rem', borderRadius: 7,
    background: 'var(--bg-subtle)', fontSize: '0.83rem', flexWrap: 'wrap' as const,
  },
  stepper: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6, listStyle: 'none', margin: 0,
    padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--border)',
  },
  stepperItem: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0.3rem 0.65rem', borderRadius: 999,
    fontSize: '0.8rem', fontWeight: 600, border: '1px solid var(--border)',
  },
  stepperStatus: {
    done: { background: '#dcfce7', color: '#166534', borderColor: '#86efac' },
    current: { background: 'var(--bg-card)', color: 'var(--text-primary)' },
    upcoming: { background: 'transparent', color: 'var(--text-secondary)', opacity: 0.7 },
  } as Record<ActivationStepStatus, CSSProperties>,
  stepperCurrent: { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)' },
  stepperBadge: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18,
    borderRadius: 999, fontSize: '0.72rem', background: 'color-mix(in srgb, currentColor 14%, transparent)',
  },
  nextStep: {
    margin: '0.75rem 1.25rem 0', padding: '0.65rem 0.85rem', borderRadius: 8, fontSize: '0.86rem',
    background: 'color-mix(in srgb, var(--accent) 9%, var(--bg-card))', color: 'var(--text-primary)',
    borderLeft: '3px solid var(--accent)',
  },
};
