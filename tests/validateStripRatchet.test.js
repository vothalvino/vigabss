'use strict';
// =============================================================================
// TNA-38 — validate() strips undeclared body fields on writes by default
// =============================================================================
// validate() ignored undeclared fields, so anything fillable a schema forgot to
// declare (organization_id, user_id, a foreign key) flowed from the body into
// the model. POST, PUT and PATCH now strip by default. The 442 validate() calls
// that existed pass { strip: false } explicitly; this keeps that list from
// growing, so a new route strips unless someone decides otherwise.
// =============================================================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { validate } = require('../src/middleware/validate');

const BASELINE = 442;

function optOuts() {
  let n = 0;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) n += (fs.readFileSync(p, 'utf8').match(/strip: false/g) || []).length;
    }
  };
  walk(path.join(__dirname, '..', 'src', 'routes'));
  return n;
}

function appWith(options) {
  const app = express();
  app.use(express.json());
  const handler = (req, res) => res.json(req.body);
  app.post('/x', validate({ name: { type: 'string' } }, options), handler);
  app.get('/x', validate({ name: { type: 'string' } }, options), handler);
  return app;
}

test('a write strips undeclared fields by default', async () => {
  const res = await request(appWith()).post('/x').send({ name: 'a', organization_id: 2 });
  expect(res.body).toEqual({ name: 'a' });
});

test('{ strip: false } keeps them', async () => {
  const res = await request(appWith({ strip: false })).post('/x').send({ name: 'a', organization_id: 2 });
  expect(res.body).toEqual({ name: 'a', organization_id: 2 });
});

test('the explicit opt-out list does not grow', () => {
  expect(optOuts()).toBeLessThanOrEqual(BASELINE);
});
