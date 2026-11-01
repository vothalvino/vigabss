// GQL-05 / FE-12: yoga sends results as `event: next` and ends with
// `event: complete`, but the hook only listened for 'message', so no live
// update arrived and a denied subscription was reopened for ever. The staff
// JWT also went into the EventSource URL (extensions=…authorization…).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { tokenStore } from '@/api/client';
import { useGraphQLSubscription } from '../useGraphQLSubscription';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  closed = false;
  constructor(public url: string, public init?: EventSourceInit) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) } as MessageEvent);
  }
  close() { this.closed = true; }
}

const QUERY = 'subscription($ticketId: ID!) { ticketCommentAdded(ticketId: $ticketId) { id } }';

describe('useGraphQLSubscription against yoga framing', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
    tokenStore.setAccess('secret.jwt.token');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); tokenStore.clear(); });

  it('reads `next` frames and never puts the token in the URL', () => {
    const { result } = renderHook(() => useGraphQLSubscription<{ ticketCommentAdded: { id: number } }>(QUERY, { ticketId: 7 }));
    const es = FakeEventSource.instances[0];
    expect(es.url).not.toMatch(/extensions|authorization|secret\.jwt/);
    expect(es.init?.withCredentials).toBe(true);
    act(() => es.emit('next', { data: { ticketCommentAdded: { id: 99 } } }));
    expect(result.current.data).toEqual({ ticketCommentAdded: { id: 99 } });
  });

  it('a denied subscription stops instead of reconnecting', () => {
    const { result } = renderHook(() => useGraphQLSubscription(QUERY, { ticketId: 7 }));
    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit('next', { errors: [{ message: 'Ticket not found in your organization' }] });
      es.emit('error');
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current.error).toMatch(/not found/);
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('`complete` ends the stream', () => {
    renderHook(() => useGraphQLSubscription(QUERY, { ticketId: 7 }));
    const es = FakeEventSource.instances[0];
    act(() => { es.emit('complete'); vi.advanceTimersByTime(120_000); });
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('a transport error reconnects with growing delays', () => {
    renderHook(() => useGraphQLSubscription(QUERY, { ticketId: 7 }));
    act(() => { FakeEventSource.instances[0].emit('error'); });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    act(() => { vi.advanceTimersByTime(999); });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => { FakeEventSource.instances[1].emit('error'); vi.advanceTimersByTime(1999); });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('does not subscribe until enabled', () => {
    renderHook(() => useGraphQLSubscription(QUERY, { ticketId: 7 }, { enabled: false }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
