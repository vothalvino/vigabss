import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateContractViews, queryKeys } from '@/api/queryKeys';

// FE2-14: contract and client cache keys live in one factory, so every page
// that changes a contract's status can find the views it must refresh.
describe('query-key factory', () => {
  it('a contract change refreshes the contract, the contract list and client pages', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateContractViews(qc, '5');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['contract-detail-gql', '5'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['contracts'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['client-detail-gql'] });
  });

  it('client detail keys are strings whether the id came from a route or a record', () => {
    expect(queryKeys.clients.detail(12)).toEqual(queryKeys.clients.detail('12'));
  });

  it('no page spells the contract or client keys by hand', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.tsx?$/.test(name) && !path.endsWith(join('api', 'queryKeys.ts'))) {
          if (/\[\s*'(contracts|contract-detail-gql|client-detail-gql)'/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
