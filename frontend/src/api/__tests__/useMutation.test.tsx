import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { useEffect, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMutation } from '../useMutation';

// State arrives the way loaded settings do (a non-event update), and Save
// reads it from the mutation's closure.
function SaveForm({ onSave }: { onSave: (value: string) => void }) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setValue('saved-value'), 0);
    return () => clearTimeout(timer);
  }, []);
  const save = useMutation({
    mutationFn: async () => onSave(value),
  });
  return (
    <form>
      <input aria-label="value" value={value} readOnly />
      <button type="button" onClick={() => save.mutate()}>Save</button>
    </form>
  );
}

describe('useMutation', () => {
  it('a click right after a commit runs that render\'s mutationFn', async () => {
    const saved: string[] = [];
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SaveForm onSave={value => saved.push(value)} />
      </QueryClientProvider>,
    );
    // A MutationObserver runs right after the commit, before passive effects.
    let clicked = false;
    const observer = new MutationObserver(() => {
      if (clicked || (screen.getByLabelText('value') as HTMLInputElement).value !== 'saved-value') return;
      clicked = true;
      (screen.getByText('Save') as HTMLButtonElement).click();
    });
    observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await waitFor(() => expect(saved).toHaveLength(1));
    } finally {
      observer.disconnect();
    }
    expect(saved).toEqual(['saved-value']);
  });

  it('no page imports useMutation from TanStack directly', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.tsx?$/.test(name) && !path.endsWith(join('api', 'useMutation.ts'))) {
          const imports = readFileSync(path, 'utf8').match(/import\s*\{[^}]*\}\s*from\s*'@tanstack\/react-query'/g) ?? [];
          if (imports.some(statement => /\buseMutation\b/.test(statement))) offenders.push(path);
        }
      }
    };
    walk(join(__dirname, '..', '..'));
    expect(offenders).toEqual([]);
  });
});
