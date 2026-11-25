// A message shown for a few seconds (a "saved" toast). The timer is cleared
// when the message is replaced and when the page goes away: a timer left
// running called setState on a page that no longer existed, and in tests it
// fired after the test environment had been torn down.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useTimedMessage(ms = 4000): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);

  const show = useCallback((next: string) => {
    clear();
    setMessage(next);
    timer.current = setTimeout(() => { timer.current = null; setMessage(''); }, ms);
  }, [ms]);

  return [message, show];
}
