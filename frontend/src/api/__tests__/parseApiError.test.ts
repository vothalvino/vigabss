// FE-18 — API error bodies are read in both shapes, never as "[object Object]".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseApiError } from '../errors';
import { extractApiError } from '@/components/ClientFormModal';

describe('parseApiError', () => {
  it('reads the central envelope, preferring validation details', () => {
    expect(parseApiError({ error: { code: 'X', message: 'Ticket is closed' } }, 'fb')).toBe('Ticket is closed');
    expect(parseApiError({ error: { message: 'Validation failed', details: [{ field: 'a', message: 'a is required' }, { message: 'b too long' }] } }, 'fb'))
      .toBe('a is required, b too long');
  });

  it('reads route-local string bodies and top-level messages', () => {
    expect(parseApiError({ error: 'Assignee is not a technician' }, 'fb')).toBe('Assignee is not a technician');
    expect(parseApiError({ message: 'Report failed' }, 'fb')).toBe('Report failed');
  });

  it('falls back on empty or unknown bodies', () => {
    for (const body of [undefined, null, {}, 'text', { error: {} }, { error: '' }]) {
      expect(parseApiError(body, 'fb')).toBe('fb');
    }
  });

  it('extractApiError now reads the string form too', () => {
    expect(extractApiError({ error: 'Duplicate RFC' })).toBe('Duplicate RFC');
    expect(extractApiError(new Error('Network down'))).toBe('Network down');
  });
});

describe('no call site casts an error body as { error?: string }', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); continue; }
      if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts') || name.includes('.test.')) continue;
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (/as \{ error\?: string \}/.test(line)) offenders.push(`${full}:${i + 1}`);
      });
    }
  };
  walk(join(__dirname, '..', '..'));
  it('finds none', () => { expect(offenders).toEqual([]); });
});
