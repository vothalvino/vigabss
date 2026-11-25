// A timed message clears itself, restarts its clock when replaced, and leaves
// no timer behind when the page goes away.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useTimedMessage } from '../useTimedMessage';

function Probe() {
  const [message, show] = useTimedMessage(4000);
  return <button onClick={() => show(message ? 'second' : 'first')}>{message || 'empty'}</button>;
}

afterEach(() => vi.useRealTimers());

describe('useTimedMessage', () => {
  it('shows a message and clears it after the delay', () => {
    vi.useFakeTimers();
    render(<Probe />);
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button').textContent).toBe('first');
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.getByRole('button').textContent).toBe('first');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('button').textContent).toBe('empty');
  });

  it('a new message restarts the clock', () => {
    vi.useFakeTimers();
    render(<Probe />);
    act(() => screen.getByRole('button').click());
    act(() => { vi.advanceTimersByTime(3000); });
    act(() => screen.getByRole('button').click());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button').textContent).toBe('second');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByRole('button').textContent).toBe('empty');
  });

  it('leaves no timer running after the page goes away', () => {
    vi.useFakeTimers();
    const view = render(<Probe />);
    act(() => screen.getByRole('button').click());
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
