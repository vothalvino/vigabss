// =============================================================================
// ASY-30 — remote backup uploads time out and stream large dumps in parts
// =============================================================================
// signedRequest had no timeout, so a stalled endpoint never settled: the run
// stayed 'running' and every later backup failed with 'already in progress'
// until a restart. The upload also read the whole dump into the API process
// and sent it as one PUT, which S3 caps at 5 GiB.
// =============================================================================

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cloudStorage = require('../src/services/cloudStorageService');

let server;
let handler;
let requests;
let config;
let tmpDir;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(entry);
      handler(entry, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config = {
    bucket: 'backups', region: 'us-east-1', accessKey: 'AK', secretKey: 'SK',
    endpoint: `http://127.0.0.1:${server.address().port}`, prefix: 'db/', source: 'settings',
  };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asy30-'));
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  delete process.env.BACKUP_S3_IDLE_TIMEOUT_MS;
  delete process.env.BACKUP_S3_REQUEST_TIMEOUT_MS;
});

function dumpFile(bytes) {
  const file = path.join(tmpDir, `dump-${bytes}.sql.gz`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

test('a stalled endpoint fails the upload instead of hanging it', async () => {
  process.env.BACKUP_S3_IDLE_TIMEOUT_MS = '150';
  handler = () => {}; // never answers

  const started = Date.now();
  await expect(cloudStorage.uploadBackup(dumpFile(100), 'stalled.sql.gz', config))
    .rejects.toMatchObject({ code: 'ETIMEDOUT', message: expect.stringMatching(/stalled/) });
  expect(Date.now() - started).toBeLessThan(5000);
});

test('a slow trickle still hits the total deadline', async () => {
  process.env.BACKUP_S3_REQUEST_TIMEOUT_MS = '300';
  handler = (_req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(' '), 50);
    res.on('close', () => clearInterval(timer));
  };

  await expect(cloudStorage.uploadBackup(dumpFile(100), 'trickle.sql.gz', config))
    .rejects.toMatchObject({ code: 'ETIMEDOUT', message: expect.stringMatching(/timed out/) });
});

test('a dump larger than one part is uploaded part by part and completed', async () => {
  handler = (req, res) => {
    if (req.method === 'POST' && /\?uploads=$/.test(req.url)) {
      res.end('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
    } else if (req.method === 'PUT') {
      const part = /partNumber=(\d+)/.exec(req.url)[1];
      res.writeHead(200, { ETag: `"etag-${part}"` });
      res.end();
    } else {
      res.end('<CompleteMultipartUploadResult/>');
    }
  };

  const url = await cloudStorage.uploadBackup(dumpFile(2500), 'big.sql.gz', config, { partSize: 1024 });

  expect(url).toBe(`${config.endpoint}/backups/db/big.sql.gz`);
  expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
    'POST /backups/db/big.sql.gz?uploads=',
    'PUT /backups/db/big.sql.gz?partNumber=1&uploadId=up-1',
    'PUT /backups/db/big.sql.gz?partNumber=2&uploadId=up-1',
    'PUT /backups/db/big.sql.gz?partNumber=3&uploadId=up-1',
    'POST /backups/db/big.sql.gz?uploadId=up-1',
  ]);
  expect(requests.slice(1, 4).map(r => r.body.length)).toEqual([1024, 1024, 452]);
  expect(requests[4].body.toString()).toBe(
    '<CompleteMultipartUpload>'
    + '<Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part>'
    + '<Part><PartNumber>2</PartNumber><ETag>"etag-2"</ETag></Part>'
    + '<Part><PartNumber>3</PartNumber><ETag>"etag-3"</ETag></Part>'
    + '</CompleteMultipartUpload>',
  );
  // The query string is part of the signed request.
  expect(requests[1].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
});

test('a failed part aborts the multipart upload', async () => {
  handler = (req, res) => {
    if (req.method === 'POST') {
      res.end('<InitiateMultipartUploadResult><UploadId>up-2</UploadId></InitiateMultipartUploadResult>');
    } else if (req.method === 'PUT' && /partNumber=2/.test(req.url)) {
      res.writeHead(500);
      res.end('<Error><Code>InternalError</Code></Error>');
    } else if (req.method === 'PUT') {
      res.writeHead(200, { ETag: '"etag"' });
      res.end();
    } else {
      res.writeHead(204);
      res.end();
    }
  };

  await expect(cloudStorage.uploadBackup(dumpFile(2500), 'broken.sql.gz', config, { partSize: 1024 }))
    .rejects.toThrow('Cloud upload failed: HTTP 500 (InternalError)');
  expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/backups/db/broken.sql.gz?uploadId=up-2' });
});

test('a completion answered 200 with an <Error> body is a failure', async () => {
  handler = (req, res) => {
    if (req.method === 'POST' && /\?uploads=$/.test(req.url)) {
      res.end('<InitiateMultipartUploadResult><UploadId>up-3</UploadId></InitiateMultipartUploadResult>');
    } else if (req.method === 'PUT') {
      res.writeHead(200, { ETag: '"etag"' });
      res.end();
    } else if (req.method === 'POST') {
      res.end('<Error><Code>InvalidPart</Code></Error>');
    } else {
      res.writeHead(204);
      res.end();
    }
  };

  await expect(cloudStorage.uploadBackup(dumpFile(2000), 'invalid.sql.gz', config, { partSize: 1024 }))
    .rejects.toThrow(/InvalidPart/);
  expect(requests.at(-1).method).toBe('DELETE');
});

test('a dump within one part is still a single PUT', async () => {
  handler = (_req, res) => res.end();

  await cloudStorage.uploadBackup(dumpFile(500), 'small.sql.gz', config, { partSize: 1024 });

  expect(requests.map(r => `${r.method} ${r.url}`)).toEqual(['PUT /backups/db/small.sql.gz']);
  expect(requests[0].body.length).toBe(500);
});
