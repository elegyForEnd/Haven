'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const register = require('../src/routes/desktopClient');

test('server download serves the current installer, including HEAD and resumable ranges', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ciacord-client-download-'));
  const app = express();
  register({ app, dataDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/downloads/ciacord/latest/windows-x64`;
  assert.equal((await fetch(url)).status, 404);
  await fs.mkdir(path.join(dataDir, 'clients'));
  const installer = path.join(dataDir, 'clients', 'Ciacord-Setup-latest.exe');
  await fs.writeFile(installer, 'MZ-first-installer');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-disposition'), /attachment;.*Ciacord-Setup-latest.exe/);
  assert.equal(head.headers.get('cache-control'), 'no-store');
  const partial = await fetch(url, { headers: { Range: 'bytes=0-1' } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), 'MZ');
  // Publishing a new file updates the same public URL without cached old data.
  await fs.writeFile(path.join(dataDir, 'clients', 'next.exe'), 'MZ-new-installer');
  await fs.rename(path.join(dataDir, 'clients', 'next.exe'), installer);
  const latest = await fetch(url);
  assert.equal(await latest.text(), 'MZ-new-installer');
});
