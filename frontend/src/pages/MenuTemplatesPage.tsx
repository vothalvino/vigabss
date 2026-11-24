// =============================================================================
// VigaBSS 5.0 — menu templates
// =============================================================================
// An administrator prepares a sidebar menu once and gives it to user groups
// (job roles) or to people. A template only arranges pages: each person sees
// the pages of it that their own permissions open, and nothing more.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { MenuEditor, layoutProblem } from '@/components/MenuEditor';
import { MENU_LIMITS, MY_MENU_KEY, pinnablePages, type MenuLayout, type MenuTemplate } from '@/nav/customMenu';

interface Audience { groups: Array<{ id: number; name: string }>; people: Array<{ id: number; name: string }> }
interface Draft { id: number | null; name: string; locked: boolean; layout: MenuLayout; groupIds: number[]; userIds: number[] }

const TEMPLATES_KEY = ['menu-templates'];
const blank = (): Draft => ({ id: null, name: '', locked: false, layout: { groups: [] }, groupIds: [], userIds: [] });
const toggled = (list: number[], id: number) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

export function MenuTemplatesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const templates = useQuery({ queryKey: TEMPLATES_KEY, queryFn: async () => (await apiFetch<{ data: MenuTemplate[] }>('/menus/templates')).data });
  const audience = useQuery({ queryKey: ['menu-template-audience'], queryFn: async () => (await apiFetch<{ data: Audience }>('/menus/templates/audience')).data });

  // People's menus may have changed, the administrator's own included.
  const refresh = () => { void qc.invalidateQueries({ queryKey: TEMPLATES_KEY }); void qc.invalidateQueries({ queryKey: MY_MENU_KEY }); };
  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const body = JSON.stringify({ name: d.name, locked: d.locked, layout: d.layout });
      const stored = d.id === null
        ? (await apiFetch<{ data: MenuTemplate }>('/menus/templates', { method: 'POST', body })).data
        : (await apiFetch<{ data: MenuTemplate }>(`/menus/templates/${d.id}`, { method: 'PUT', body })).data;
      await apiFetch(`/menus/templates/${stored.id}/assignments`, { method: 'PUT', body: JSON.stringify({ group_ids: d.groupIds, user_ids: d.userIds }) });
    },
    onSuccess: () => { setDraft(null); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/menus/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setDraft(null); refresh(); },
  });

  if (templates.isLoading || !user) return <p className="menu-page">{t('customMenu.loading')}</p>;
  if (templates.isError || !templates.data) return <p className="menu-page" role="alert">{t('customMenu.loadFailed')}</p>;

  const edit = (tpl: MenuTemplate) => { save.reset(); remove.reset(); setDraft({ id: tpl.id, name: tpl.name, locked: tpl.locked, layout: tpl.layout, groupIds: tpl.groups.map(g => g.id), userIds: tpl.people.map(p => p.id) }); };
  const failure = (save.error ?? remove.error) as Error | null;
  const problem = draft ? (!draft.name.trim() ? 'customMenu.problems.templateName' : layoutProblem(draft.layout)) : null;
  const busy = save.isPending || remove.isPending;

  return (
    <div className="menu-page">
      <h1 className="menu-page-title">{t('customMenu.templates.title')}</h1>
      <p className="menu-page-hint">{t('customMenu.templates.intro')}</p>

      {draft === null ? (
        <>
          <button type="button" className="menu-editor-btn menu-page-save" onClick={() => { save.reset(); setDraft(blank()); }}>{t('customMenu.templates.new')}</button>
          {templates.data.length === 0 && <p className="menu-page-note">{t('customMenu.templates.none')}</p>}
          <ul className="menu-template-list">
            {templates.data.map(tpl => (
              <li key={tpl.id} className="menu-template-item">
                <div>
                  <strong>{tpl.name}</strong>
                  {tpl.locked && <span className="menu-template-locked">{t('customMenu.templates.lockedBadge')}</span>}
                  <div className="menu-page-hint">
                    {tpl.groups.length + tpl.people.length === 0
                      ? t('customMenu.templates.givenToNobody')
                      : t('customMenu.templates.givenTo', { list: [...tpl.groups, ...tpl.people].map(x => x.name).join(', ') })}
                  </div>
                </div>
                <button type="button" className="menu-editor-btn" aria-label={t('customMenu.templates.editNamed', { name: tpl.name })} onClick={() => edit(tpl)}>{t('customMenu.templates.edit')}</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form onSubmit={e => { e.preventDefault(); if (!problem) save.mutate(draft); }}>
          <label className="menu-page-field">
            {t('customMenu.templates.name')}
            <input className="menu-editor-name" value={draft.name} maxLength={MENU_LIMITS.templateName} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="menu-page-check">
            <input type="checkbox" checked={draft.locked} onChange={e => setDraft({ ...draft, locked: e.target.checked })} />
            {t('customMenu.templates.locked')}
          </label>
          <MenuEditor value={draft.layout} onChange={layout => setDraft({ ...draft, layout })} pages={pinnablePages(user)} />

          <fieldset className="menu-editor-group">
            <legend className="menu-editor-legend">{t('customMenu.templates.audienceGroups')}</legend>
            {(audience.data?.groups ?? []).map(group => (
              <label key={group.id} className="menu-page-check">
                <input type="checkbox" checked={draft.groupIds.includes(group.id)} onChange={() => setDraft({ ...draft, groupIds: toggled(draft.groupIds, group.id) })} />
                {group.name}
              </label>
            ))}
          </fieldset>
          <fieldset className="menu-editor-group">
            <legend className="menu-editor-legend">{t('customMenu.templates.audiencePeople')}</legend>
            {(audience.data?.people ?? []).map(person => (
              <label key={person.id} className="menu-page-check">
                <input type="checkbox" checked={draft.userIds.includes(person.id)} onChange={() => setDraft({ ...draft, userIds: toggled(draft.userIds, person.id) })} />
                {person.name}
              </label>
            ))}
          </fieldset>
          <p className="menu-page-hint">{t('customMenu.templates.audienceHint')}</p>

          {problem && <p role="alert" className="menu-page-problem">{t(problem)}</p>}
          {failure && <p role="alert" className="menu-page-problem">{failure.message}</p>}
          <div className="menu-page-actions">
            <button type="submit" className="menu-editor-btn menu-page-save" disabled={busy || problem !== null}>{t('customMenu.save')}</button>
            <button type="button" className="menu-editor-btn" disabled={busy} onClick={() => setDraft(null)}>{t('customMenu.cancel')}</button>
            {draft.id !== null && (
              <button type="button" className="menu-editor-btn menu-page-danger" disabled={busy} onClick={() => remove.mutate(draft.id as number)}>{t('customMenu.templates.delete')}</button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
