// ASY-40 — the bot's language comes from the client's organization.
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const db = require('../src/config/database');
const wa = require('../src/services/whatsappService');

beforeEach(() => jest.clearAllMocks());

test.each([['es-MX', 'es'], ['pt-BR', 'pt-BR'], ['en-US', 'en'], ['fr-FR', null], [null, null]])('%p maps to %p', (tag, locale) => {
  expect(wa.botLocaleFor(tag)).toBe(locale);
});

test("the organization's AI policy default_locale wins", async () => {
  db.query.mockResolvedValueOnce([[{ default_locale: 'pt-BR' }]]);
  await expect(wa.botLocale(4)).resolves.toBe('pt-BR');
});

test('without a policy, an MX organization gets Spanish and any other English', async () => {
  db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ locale: 'MX' }]]);
  await expect(wa.botLocale(4)).resolves.toBe('es');
  db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ locale: 'global' }]]);
  await expect(wa.botLocale(5)).resolves.toBe('en');
});

test('a lookup failure falls back to the install default (Spanish)', async () => {
  db.query.mockRejectedValueOnce(new Error('tenant db down'));
  await expect(wa.botLocale(4)).resolves.toBe('es');
});
