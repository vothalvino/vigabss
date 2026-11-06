// A user who can load none of the Operations Console's data lands on a page
// they can open (Resellers for a reseller user) instead of a wall of 403s.
import { describe, expect, it } from 'vitest';
import { landingWithoutOperations } from '../Dashboard';

const RESELLER = [
  'reseller_portal.dashboard', 'reseller_portal.manage_customers', 'reseller_portal.invoices',
  'reseller_portal.inventory', 'resellers.view', 'webauthn.view',
];

describe('landingWithoutOperations', () => {
  it('sends a reseller user to Resellers', () => {
    expect(landingWithoutOperations({ role: 'billing', permissions: RESELLER })).toBe('/resellers');
  });

  it('keeps the console for anyone who can load any of its data', () => {
    expect(landingWithoutOperations({ role: 'billing', permissions: [...RESELLER, 'invoices.view'] })).toBeNull();
    expect(landingWithoutOperations({ role: 'support', permissions: ['devices.view'] })).toBeNull();
    expect(landingWithoutOperations({ role: 'support', permissions: ['tickets.view'] })).toBeNull();
  });

  it('never redirects an admin, or a session without resolved permissions', () => {
    expect(landingWithoutOperations({ role: 'admin', permissions: [] })).toBeNull();
    expect(landingWithoutOperations({ role: 'billing' })).toBeNull();
  });

  it('a user without operations access and without Resellers goes to their first visible page', () => {
    const landing = landingWithoutOperations({ role: 'support', permissions: ['leads.view'] });
    expect(landing).not.toBeNull();
    expect(landing).not.toBe('/');
  });
});
