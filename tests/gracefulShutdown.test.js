// =============================================================================
// OPS-13 — shutdown completes with a WebSocket client and an SSE stream open
// =============================================================================
// server.close()'s callback fires only after every socket has closed, and the
// WebSocket servers were closed inside that callback, so one connected staff
// tab kept the process alive until the force-exit timer (exit 1) or SIGKILL,
// skipping the job queue and DB teardown.
// =============================================================================

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createGracefulShutdown } = require('../src/utils/gracefulShutdown');

const logger = { info: jest.fn(), warn: jest.fn() };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('a connected WebSocket client and an open SSE stream do not stop a clean exit', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(':ok\n\n'); // held open, like routes/events.js
      return;
    }
    res.end('ok');
  });
  const wss = new WebSocketServer({ server });
  const hub = {
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }),
  };
  const port = await listen(server);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((resolve) => ws.on('open', resolve));
  await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/events`, (res) => { res.once('data', resolve); }));

  const order = [];
  const exit = jest.fn();
  const shutdown = createGracefulShutdown({
    server,
    socketServers: [hub],
    stopIntake: () => { order.push('intake'); },
    closeQueues: async () => { order.push('queues'); },
    closeDb: async () => { order.push('db'); },
    logger,
    drainMs: 200,
    timeoutMs: 5000,
    exit,
  });

  const started = Date.now();
  await shutdown('SIGTERM');

  expect(exit).toHaveBeenCalledWith(0);
  expect(exit).not.toHaveBeenCalledWith(1);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(order).toEqual(['intake', 'queues', 'db']);
  expect(server.listening).toBe(false);
});

test('a second signal does not start a second shutdown', async () => {
  const server = http.createServer();
  await listen(server);
  const closeDb = jest.fn(async () => {});
  const shutdown = createGracefulShutdown({ server, closeDb, logger, drainMs: 50, exit: jest.fn() });
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  expect(closeDb).toHaveBeenCalledTimes(1);
});

test('server.js closes the WebSocket servers through the helper, and the app has a 30 s grace period', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  expect(src).toMatch(/socketServers: \[tunnelServer, wsHub\]/);
  expect(src).not.toMatch(/server\.close\(async \(\) => \{[\s\S]*?wsHub\.close/);
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.prod.yml'), 'utf8');
  const app = compose.slice(compose.indexOf('\n  app:\n'), compose.indexOf('\n  wireguard-helper:\n'));
  expect(app).toMatch(/\n {4}stop_grace_period: 30s\n/);
});
