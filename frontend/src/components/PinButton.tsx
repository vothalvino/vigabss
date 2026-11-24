// =============================================================================
// VigaBSS 5.0 — pin the open page to my menu
// =============================================================================
// A button in the top bar: tick the groups of your menu the open page should
// be in, or name a new group. Saved at once as the person's own menu. Not
// shown when their menu is locked by a template.
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import type { NavUser, RouteDef } from '@/nav/routes';
import { MENU_LIMITS, MY_MENU_KEY, ownLayout, saveMyMenu, togglePin, type MenuLayout, type MyMenu } from '@/nav/customMenu';

export function PinButton({ user, route, menu }: { user: NavUser; route: RouteDef; menu: MyMenu }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const layout = ownLayout(user, menu.layout);
  const pinned = layout.groups.some(group => group.pages.includes(route.path));
  const save = useMutation({
    mutationFn: (next: MenuLayout) => saveMyMenu(next),
    onSuccess: next => { qc.setQueryData(MY_MENU_KEY, next); setName(''); },
  });

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  const page = t(route.labelKey);
  const fresh = name.trim();
  const canAdd = fresh.length > 0 && layout.groups.length < MENU_LIMITS.groups && !layout.groups.some(group => group.name.toLowerCase() === fresh.toLowerCase());

  return (
    <div className="pin-box" ref={box}>
      <button
        type="button" className={`pin-btn${pinned ? ' pinned' : ''}`} aria-expanded={open} aria-controls="pin-panel"
        aria-label={t(pinned ? 'customMenu.pin.pinned' : 'customMenu.pin.pin', { page })} title={t(pinned ? 'customMenu.pin.pinned' : 'customMenu.pin.pin', { page })}
        onClick={() => setOpen(cur => !cur)}
      >
        <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
      </button>
      {open && (
        <div id="pin-panel" className="pin-panel">
          <div className="pin-panel-title">{t('customMenu.pin.title', { page })}</div>
          {layout.groups.length === 0 && <p className="pin-panel-hint">{t('customMenu.pin.noGroups')}</p>}
          {layout.groups.map(group => (
            <label key={group.name} className="menu-page-check">
              <input type="checkbox" disabled={save.isPending} checked={group.pages.includes(route.path)} onChange={() => save.mutate(togglePin(layout, group.name, route.path))} />
              {group.name}
            </label>
          ))}
          <form className="pin-panel-new" onSubmit={e => { e.preventDefault(); if (canAdd) save.mutate(togglePin(layout, fresh, route.path)); }}>
            <input className="menu-editor-name" value={name} maxLength={MENU_LIMITS.name} aria-label={t('customMenu.pin.newGroup')} placeholder={t('customMenu.pin.newGroup')} onChange={e => setName(e.target.value)} />
            <button type="submit" className="menu-editor-btn" disabled={!canAdd || save.isPending}>{t('customMenu.pin.add')}</button>
          </form>
          {save.error && <p role="alert" className="menu-page-problem">{(save.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}
