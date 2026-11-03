// FE2-13: shared, runtime-guarded readers for the two response envelopes, so
// a page reading the wrong shape renders nothing instead of throwing.
import { describe, expect, it } from 'vitest';
import { unwrapData, unwrapList, listTotal } from '../envelope';

describe('response envelope helpers', () => {
  it('unwrapList reads { data: [...] } and a bare array', () => {
    expect(unwrapList<number>({ data: [1, 2], meta: { total: 2 } })).toEqual([1, 2]);
    expect(unwrapList<number>([3])).toEqual([3]);
  });

  it('unwrapList is empty for anything that is not a list', () => {
    expect(unwrapList({ data: { id: 1 } })).toEqual([]);
    expect(unwrapList({ error: { message: 'nope' } })).toEqual([]);
    expect(unwrapList(null)).toEqual([]);
    expect(unwrapList('text')).toEqual([]);
  });

  it('unwrapData returns the payload, or the body when it is not wrapped', () => {
    expect(unwrapData({ data: { id: 1 } })).toEqual({ id: 1 });
    expect(unwrapData({ id: 2 })).toEqual({ id: 2 });
  });

  it('listTotal prefers meta.total, then total, then the row count', () => {
    expect(listTotal({ data: [1], meta: { total: 40 } })).toBe(40);
    expect(listTotal({ data: [1], total: '7' })).toBe(7);
    expect(listTotal({ data: [1, 2] })).toBe(2);
  });
});
