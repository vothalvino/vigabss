// =============================================================================
// VigaBSS 5.0 — my menu
// =============================================================================
// Where a person arranges their own sidebar: groups they name, holding the
// pages they pick from the ones they may open. Someone given a locked
// template sees it here and cannot change it.
// =============================================================================
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { MenuEditor, layoutProblem } from '@/components/MenuEditor';
import { MY_MENU_KEY, fetchMyMenu, ownLayout, pinnablePages, saveMyMenu, type MenuLayout, type MyMenu } from '@/nav/customMenu';

export function MyMenuPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: MY_MENU_KEY, queryFn: fetchMyMenu });
  const [draft, setDraft] = useState<MenuLayout | null>(null);
  const [saved, setSaved] = useState(false);

  // Start from what the person sees now, reduced to pages they may open.
  useEffect(() => { if (data && user && draft === null) setDraft(ownLayout(user, data.layout)); }, [data, user, draft]);

  const done = (next: MyMenu) => { qc.setQueryData(MY_MENU_KEY, next); if (user) setDraft(ownLayout(user, next.layout)); setSaved(true); };
  const save = useMutation({ mutationFn: (layout: MenuLayout) => saveMyMenu(layout), onSuccess: done });
  const reset = useMutation({
    mutationFn: async () => (await apiFetch<{ data: MyMenu }>('/menus/mine', { method: 'DELETE' })).data,
    onSuccess: done,
  });

  if (isError) return <p className="menu-page" role="alert">{t('customMenu.loadFailed')}</p>;
  // The draft is filled just after the menu arrives.
  if (isLoading || !user || !data || draft === null) return <p className="menu-page">{t('customMenu.loading')}</p>;

  const problem = layoutProblem(draft);
  const failure = (save.error ?? reset.error) as Error | null;
  const busy = save.isPending || reset.isPending;
  const fallback = data.template ? t('customMenu.backToTemplate', { name: data.template.name }) : t('customMenu.backToStandard');

  return (
    <div className="menu-page">
      <h1 className="menu-page-title">{t('customMenu.myMenu')}</h1>
      <p className="menu-page-hint">{t('customMenu.intro')}</p>
      {data.source === 'template' && data.template && (
        <p className="menu-page-note">{t(data.can_edit ? 'customMenu.usingTemplate' : 'customMenu.lockedTemplate', { name: data.template.name })}</p>
      )}
      {data.can_edit ? (
        <>
          <MenuEditor value={draft} onChange={next => { setDraft(next); setSaved(false); }} pages={pinnablePages(user)} />
          {problem && <p role="alert" className="menu-page-problem">{t(problem)}</p>}
          {failure && <p role="alert" className="menu-page-problem">{failure.message}</p>}
          {saved && !failure && <p role="status" className="menu-page-note">{t('customMenu.saved')}</p>}
          <div className="menu-page-actions">
            <button type="button" className="menu-editor-btn menu-page-save" disabled={busy || problem !== null} onClick={() => save.mutate(draft)}>{t('customMenu.save')}</button>
            {data.source === 'personal' && (
              <button type="button" className="menu-editor-btn" disabled={busy} onClick={() => reset.mutate()}>{fallback}</button>
            )}
          </div>
        </>
      ) : (
        <ul className="menu-page-readonly">
          {draft.groups.map(group => <li key={group.name}><strong>{group.name}</strong>: {group.pages.length}</li>)}
        </ul>
      )}
    </div>
  );
}
