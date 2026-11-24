// My menu and Menu templates: arranging groups and pages, and what is sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyMenuPage } from '../MyMenuPage';
import { MenuTemplatesPage } from '../MenuTemplatesPage';

let user: { role: string; organization_locale?: string; permissions?: string[] } = { role: 'admin', organization_locale: 'MX' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user }) }));

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
let mine: unknown;
let templates: unknown[];
vi.mock('@/api/apiFetch', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') calls.push({ path, method, body });
    if (path === '/menus/mine') {
      if (method === 'PUT') mine = { layout: body.layout, source: 'personal', template: null, can_edit: true };
      if (method === 'DELETE') mine = { layout: null, source: 'standard', template: null, can_edit: true };
      return { data: mine };
    }
    if (path === '/menus/templates/audience') return { data: { groups: [{ id: 3, name: 'billing' }, { id: 4, name: 'support' }], people: [{ id: 9, name: 'Ana Ruiz' }] } };
    if (path === '/menus/templates' && method === 'GET') return { data: templates };
    if (path === '/menus/templates' && method === 'POST') return { data: { id: 12, ...body, groups: [], people: [] } };
    return { data: { id: 7, groups: [], people: [] } };
  },
}));

function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  user = { role: 'admin', organization_locale: 'MX' };
  mine = { layout: null, source: 'standard', template: null, can_edit: true };
  templates = [];
});

describe('My menu', () => {
  it('builds a menu from nothing: a named group with pages picked from the ones allowed', async () => {
    show(<MyMenuPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a group' }));
    // A group without a name cannot be saved.
    expect(screen.getByRole('alert').textContent).toBe('Give every group a name.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Collections' } });
    const add = screen.getByRole('combobox', { name: 'Add a page to Collections' });
    fireEvent.change(add, { target: { value: '/invoices' } });
    fireEvent.change(add, { target: { value: '/payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Payments up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([{ path: '/menus/mine', method: 'PUT', body: { layout: { groups: [{ name: 'Collections', pages: ['/payments', '/invoices'] }] } } }]));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    // Their own menu can be dropped again.
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the standard menu' }));
    await waitFor(() => expect(calls[1]).toEqual({ path: '/menus/mine', method: 'DELETE', body: null }));
  });

  it('offers only pages the person may open', async () => {
    user = { role: 'custom', permissions: ['invoices.view'] };
    mine = { layout: { groups: [{ name: 'Daily', pages: ['/invoices', '/users'] }] }, source: 'template', template: { id: 7, name: 'Desk', locked: false, given_to: 'group' }, can_edit: true };
    show(<MyMenuPage />);
    const add = await screen.findByRole('combobox', { name: 'Add a page to Daily' });
    const offered = [...(add as HTMLSelectElement).options].map(o => o.value).filter(Boolean);
    expect(offered).not.toContain('/users');
    expect(offered).not.toContain('/payments');
    // The template's page they cannot open is not carried into their own menu.
    expect(screen.queryByText('Users')).toBeNull();
    expect(screen.getByText(/You are using the menu “Desk”/)).toBeInTheDocument();
  });

  it('a locked template is shown but cannot be changed', async () => {
    mine = { layout: { groups: [{ name: 'Daily', pages: ['/invoices'] }] }, source: 'template', template: { id: 7, name: 'Desk', locked: true, given_to: 'group' }, can_edit: false };
    show(<MyMenuPage />);
    expect(await screen.findByText(/It cannot be changed here/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a group' })).toBeNull();
  });

  it('two groups may not share a name', async () => {
    mine = { layout: { groups: [{ name: 'A', pages: [] }, { name: 'a', pages: [] }] }, source: 'personal', template: null, can_edit: true };
    show(<MyMenuPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Two groups have the same name.');
  });
});

describe('Menu templates', () => {
  it('creates a template and says who gets it', async () => {
    show(<MenuTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Billing desk' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Locked/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Group name' }), { target: { value: 'Daily' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a page to Daily' }), { target: { value: '/invoices' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'billing' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ana Ruiz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({ path: '/menus/templates', method: 'POST', body: { name: 'Billing desk', locked: true, layout: { groups: [{ name: 'Daily', pages: ['/invoices'] }] } } });
    expect(calls[1]).toEqual({ path: '/menus/templates/12/assignments', method: 'PUT', body: { group_ids: [3], user_ids: [9] } });
  });

  it('lists templates with who has them, and edits or deletes one', async () => {
    templates = [{ id: 7, name: 'Billing desk', locked: true, layout: { groups: [{ name: 'Daily', pages: ['/invoices'] }] }, groups: [{ id: 3, name: 'billing' }], people: [{ id: 9, name: 'Ana Ruiz' }] }];
    show(<MenuTemplatesPage />);
    const item = (await screen.findByText('Billing desk')).closest('li') as HTMLElement;
    expect(within(item).getByText('Locked')).toBeInTheDocument();
    expect(within(item).getByText('Given to: billing, Ana Ruiz')).toBeInTheDocument();
    fireEvent.click(within(item).getByRole('button', { name: 'Edit Billing desk' }));
    expect((screen.getByRole('textbox', { name: 'Template name' }) as HTMLInputElement).value).toBe('Billing desk');
    expect(await screen.findByRole('checkbox', { name: 'billing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'support' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'billing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({ path: '/menus/templates/7', method: 'PUT' });
    expect(calls[1]).toEqual({ path: '/menus/templates/7/assignments', method: 'PUT', body: { group_ids: [], user_ids: [9] } });
  });

  it('a template needs a name', async () => {
    show(<MenuTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the template a name.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('deletes a template', async () => {
    templates = [{ id: 7, name: 'Billing desk', locked: false, layout: { groups: [] }, groups: [], people: [] }];
    show(<MenuTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Billing desk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(calls).toEqual([{ path: '/menus/templates/7', method: 'DELETE', body: null }]));
  });
});
