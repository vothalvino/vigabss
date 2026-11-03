// =============================================================================
// Keyboard focus for modal dialogs (FE-22)
// =============================================================================
// About 70 pages render their own role="dialog" aria-modal="true" overlay, and
// nothing kept Tab inside them: a keyboard user tabbed straight into the page
// behind, and focus stayed on the button that opened the dialog. Mounted once
// at the app root, this manages every modal dialog in the document, whoever
// rendered it:
//   - when one opens, focus moves into it ([autofocus] / [data-autofocus],
//     else its first field, else its first focusable);
//   - Tab and Shift+Tab cycle inside the topmost one;
//   - when it closes, focus returns to what had it before.
// A non-modal popover (no aria-modal) is left alone.
// =============================================================================

import { useEffect } from 'react';

const DIALOG = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'audio[controls]', 'video[controls]',
  '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])',
].join(', ');
const FIELD = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';

function visible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[hidden], [inert]');
}

export function focusableIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** The dialog that owns the keyboard: the last open modal in document order. */
export function topDialog(doc: Document = document): HTMLElement | null {
  const open = [...doc.querySelectorAll<HTMLElement>(DIALOG)].filter(visible);
  return open[open.length - 1] ?? null;
}

function initialFocus(dialog: HTMLElement): HTMLElement {
  const preferred = dialog.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
  if (preferred) return preferred;
  const field = [...dialog.querySelectorAll<HTMLElement>(FIELD)].find(visible);
  if (field) return field;
  const first = focusableIn(dialog)[0];
  if (first) return first;
  // Nothing focusable: the dialog itself takes focus so Tab stays inside.
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
  return dialog;
}

export function DialogFocusManager() {
  useEffect(() => {
    // dialog → the element that had focus before it opened
    const returnTo = new Map<HTMLElement, HTMLElement | null>();

    const sync = () => {
      const open = new Set([...document.querySelectorAll<HTMLElement>(DIALOG)].filter(visible));
      for (const dialog of open) {
        if (returnTo.has(dialog)) continue;
        const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        returnTo.set(dialog, before && !dialog.contains(before) ? before : null);
        if (!dialog.contains(document.activeElement)) initialFocus(dialog).focus();
      }
      for (const [dialog, before] of [...returnTo]) {
        if (open.has(dialog)) continue;
        returnTo.delete(dialog);
        const next = topDialog();
        const target = before && before.isConnected ? before : null;
        // Back to the opener, unless another dialog is still open over it.
        if (target && (!next || next.contains(target))) target.focus();
        else if (next && !next.contains(document.activeElement)) initialFocus(next).focus();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = topDialog();
      if (!dialog) return;
      const items = focusableIn(dialog);
      if (items.length === 0) { e.preventDefault(); dialog.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? dialog.contains(active) : false;
      if (e.shiftKey && (!inside || active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'hidden'],
    });
    document.addEventListener('keydown', onKeyDown, true);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return null;
}
