// FE-22: nothing kept keyboard focus inside the ~70 hand-rolled modal
// dialogs, and focus stayed on the button that opened one. The manager
// handles every role="dialog" aria-modal="true" element in the document.
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DialogFocusManager } from '../DialogFocusManager';

function Page({ modal = true }: { modal?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DialogFocusManager />
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <a href="#behind">Behind</a>
      {open && (
        <div role="dialog" aria-modal={modal ? 'true' : undefined} aria-label="Record payment">
          <button type="button" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          <label htmlFor="amt">Amount</label>
          <input id="amt" />
          <button type="button" onClick={() => setOpen(false)}>Save</button>
        </div>
      )}
    </>
  );
}

describe('DialogFocusManager', () => {
  it('moves focus to the first field when a modal opens', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveFocus());
  });

  it('keeps Tab and Shift+Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveFocus());
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.tab(); // past the last: back to the first
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab({ shift: true }); // before the first: to the last
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Behind' })).not.toHaveFocus();
  });

  it('returns focus to the opener when the dialog closes', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('leaves a non-modal popover alone', async () => {
    const user = userEvent.setup();
    render(<Page modal={false} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await new Promise(r => setTimeout(r, 0));
    expect(opener).toHaveFocus();
  });
});
