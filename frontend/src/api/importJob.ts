// =============================================================================
// CSV imports as background jobs (migration 522)
// =============================================================================
// POST /import/<entity>/upload answers 202 with a job; the server imports in
// a worker and GET /import/jobs/:id reports the result. uploadImport sends
// the file and waits for the job, so a page still gets { imported, total,
// errors } back, now without holding one request open for the whole import.
// =============================================================================

import { apiFetch } from './apiFetch';

export interface ImportError { row: number; error: string }
export interface ImportResult { imported: number; total: number; errors: ImportError[] }

interface ImportJob {
  id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  total_rows: number | null;
  imported_rows: number | null;
  row_errors: ImportError[];
  error_message: string | null;
}

const POLL_MS = 1000;
const MAX_POLL_MS = 5000;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** Upload a CSV for `entity` and wait for its import job to finish. */
export async function uploadImport(entity: string, file: File, { pollMs = POLL_MS }: { pollMs?: number } = {}): Promise<ImportResult> {
  const formData = new FormData();
  formData.append('file', file);
  const queued = await apiFetch<{ data: ImportJob }>(`/import/${entity}/upload`, { method: 'POST', body: formData });
  let job = queued.data;
  let wait = pollMs;
  while (job.status === 'queued' || job.status === 'running') {
    await sleep(wait);
    // Back off gently: a 10,000-row file takes a while.
    wait = Math.min(MAX_POLL_MS, Math.round(wait * 1.5));
    job = (await apiFetch<{ data: ImportJob }>(`/import/jobs/${job.id}`)).data;
  }
  if (job.status === 'failed') throw new Error(job.error_message || 'Import failed');
  return { imported: job.imported_rows ?? 0, total: job.total_rows ?? 0, errors: job.row_errors ?? [] };
}
