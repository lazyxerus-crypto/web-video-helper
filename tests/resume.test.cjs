'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extensionHarness() {
  const local = new Map();
  const session = new Map();
  let onMessage;
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return Object.fromEntries(local);
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter(k => local.has(k)).map(k => [k, local.get(k)]));
        },
        async set(items) { for (const [key, value] of Object.entries(items)) local.set(key, value); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) local.delete(key); }
      },
      session: {
        async get(key) { return { [key]: session.get(key) }; },
        async set(items) { for (const [key, value] of Object.entries(items)) session.set(key, value); },
        async remove(key) { session.delete(key); }
      }
    },
    action: { onClicked: { addListener() {} }, async setBadgeText() {} },
    tabs: {
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
      async sendMessage() { return { ok: true }; }
    },
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } } }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const api = vm.runInNewContext(source + '\n;({toggle,episodeKey})',
    { chrome, URL, console, setTimeout, clearTimeout });
  const send = (msg, tab, documentId = 'document-1') =>
    new Promise(resolve => onMessage(msg, { tab, frameId: 1, documentId }, resolve));
  return { api, send, local };
}

test('per-episode local resume checkpoint and completed record cleanup', async () => {
  const { api, send, local } = extensionHarness();
  const tab = {
    id: 42,
    url: 'https://kf.carsstore365.com/up/105522/watch/?server=12&slug=04a'
  };
  const next = { ...tab, url: tab.url.replace('04a', '05') };

  assert.equal(api.episodeKey(tab.url),
    api.episodeKey('https://kf.carsstore365.com/up/105522/watch/?slug=04a&server=12#time'));
  assert.notEqual(api.episodeKey(tab.url), api.episodeKey(next.url));
  assert.equal((await send({ type: 'WVFS_READY' }, tab)).state.enabled, false);
  await api.toggle(tab);
  assert.equal((await send({ type: 'WVFS_READY' }, next)).state.enabled, true);

  let data = await send({ type: 'WVFS_RESUME_GET' }, tab);
  assert.equal(data.checkpoint, null);
  assert.equal((await send({
    type: 'WVFS_RESUME_SAVE', episode: data.episode, position: 145.6, duration: 1500
  }, tab)).ok, true);

  data = await send({ type: 'WVFS_RESUME_GET' }, tab);
  assert.equal(data.checkpoint.position, 145.6);
  assert.equal((await send({ type: 'WVFS_RESUME_GET' }, next)).checkpoint, null);
  assert.equal((await send({
    type: 'WVFS_RESUME_SAVE', episode: data.episode, position: 400, duration: 1500
  }, next)).ok, false, 'reject an old iframe writing after SPA URL change');

  assert.equal((await send({ type: 'WVFS_RESUME_COMPLETE', episode: data.episode }, tab)).ok, true);
  assert.equal((await send({ type: 'WVFS_RESUME_GET' }, tab)).checkpoint, null);
  assert.equal((await send({
    type: 'WVFS_RESUME_SAVE', episode: data.episode, position: 150, duration: 1500
  }, tab)).ok, false, 'reject a late save from the completed video');

  // Loading the same video in a new document is a fresh session.
  assert.equal((await send({ type: 'WVFS_RESUME_GET' }, tab, 'document-2')).checkpoint, null);
  assert.equal((await send({
    type: 'WVFS_RESUME_SAVE', episode: data.episode, position: 205, duration: 1500
  }, tab, 'document-2')).ok, true);
  assert.equal((await send({ type: 'WVFS_RESUME_GET' }, tab, 'document-2')).checkpoint.position, 205);

  const unrelated = { id: 43, url: 'https://example.com/article' };
  assert.equal((await send({ type: 'WVFS_READY' }, unrelated)).state.enabled, false);
  assert(local.size > 0);
});
