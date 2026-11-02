// =============================================================================
// RTE-06 / SUP-08 — AI-support knowledge base routes
// =============================================================================

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({ authenticate: (req, _res, next) => { req.user = { id: 1 }; next(); } }));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 4; next(); } }));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));

const kbService = require('../src/services/kbService');
const router = require('../src/routes/supportConversations');

const app = express();
app.use(express.json());
app.use('/support', router);

afterEach(() => jest.restoreAllMocks());

test('feedback records against an article of the organization', async () => {
  jest.spyOn(kbService, 'getArticle').mockResolvedValue({ id: 5 });
  const add = jest.spyOn(kbService, 'addFeedback').mockResolvedValue({ id: 99 });
  const res = await request(app).post('/support/kb/5/feedback').send({ feedback: 'helpful' });
  expect(res.status).toBe(201);
  expect(add).toHaveBeenCalledWith({ articleId: 5, feedback: 'helpful', notes: null });
});

test("feedback on another organization's article is a 404", async () => {
  jest.spyOn(kbService, 'getArticle').mockResolvedValue(null);
  const add = jest.spyOn(kbService, 'addFeedback');
  const res = await request(app).post('/support/kb/5/feedback').send({ feedback: 'wrong' });
  expect(res.status).toBe(404);
  expect(add).not.toHaveBeenCalled();
});

test('the staff list includes drafts unless narrowed', async () => {
  const list = jest.spyOn(kbService, 'listArticles').mockResolvedValue([]);
  await request(app).get('/support/kb');
  expect(list.mock.calls[0][1].isPublished).toBeNull();
  await request(app).get('/support/kb?published=true');
  expect(list.mock.calls[1][1].isPublished).toBe(1);
});

test('editing a missing or foreign article is a 404, and is_published is honoured', async () => {
  jest.spyOn(kbService, 'getArticle').mockResolvedValueOnce(null);
  const update = jest.spyOn(kbService, 'updateArticle').mockResolvedValue({ affected: 1 });
  const missing = await request(app).put('/support/kb/123456').send({ title: 'x' });
  expect(missing.status).toBe(404);
  expect(update).not.toHaveBeenCalled();

  jest.spyOn(kbService, 'getArticle').mockResolvedValue({ id: 5, is_published: 1 });
  const ok = await request(app).put('/support/kb/5').send({ is_published: true });
  expect(ok.status).toBe(200);
  expect(update).toHaveBeenCalledWith(5, 4, { is_published: true });
});

test('deleting a missing article is a 404', async () => {
  jest.spyOn(kbService, 'deleteArticle').mockResolvedValue({ affected: 0 });
  const res = await request(app).delete('/support/kb/123456');
  expect(res.status).toBe(404);
});
