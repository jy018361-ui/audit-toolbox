const {test} = require('node:test');
const assert = require('node:assert/strict');
const publish = require('./publish_channel_release.cjs');
const repo = {owner: 'example', repo: 'toolbox'};
const manifest = version => ({version, platforms: {'windows-x86_64': {
  signature: 'signed', url: `https://github.com/example/toolbox/releases/download/v${version}/setup.exe`,
}}});

test('development versions compare numerically and reject other channels', () => {
  assert.equal(publish.isNewer('2.0.0-dev.10', '2.0.0-dev.9'), true);
  assert.equal(publish.isNewer('2.0.0-dev.1', '2.0.0-dev.2'), false);
  assert.equal(publish.isNewer('2.0.0-dev.2', '2.0.0-dev.2'), false);
  assert.throws(() => publish.isNewer('2.0.0', '2.0.0-dev.2'));
  assert.throws(() => publish.validateManifest(manifest('2.0.0-dev.1'), 'v2.0.0-dev.2', repo));
  const wrong = manifest('2.0.0-dev.1');
  wrong.platforms['windows-x86_64'].url = 'https://github.com/example/toolbox/releases/latest/download/setup.exe';
  assert.throws(() => publish.validateManifest(wrong, 'v2.0.0-dev.1', repo));
});

async function scenario(channel, previous) {
  const calls = [];
  const tag = channel === 'dev' ? 'v2.0.0-dev.2' : 'v2.0.0-alpha.132';
  Object.assign(process.env, {RELEASE_CHANNEL: channel, RELEASE_TAG: tag, RELEASE_ID: '1', RELEASE_SHA: 'abc'});
  const api = {
    getRelease: async () => ({data: {draft: true, tag_name: tag, assets: [{name: 'latest.json'}, {name: 'setup.exe.sig'}]}}),
    updateRelease: async args => { calls.push(['update', args]); return {data: args}; },
    getReleaseByTag: async () => ({data: {id: 2, prerelease: true, assets: previous ? [{id: 3, name: 'latest.json'}] : []}}),
    deleteReleaseAsset: async args => { calls.push(['delete', args]); },
    uploadReleaseAsset: async args => { calls.push(['upload', args]); },
  };
  const fetch = async url => ({ok: true, json: async () => manifest(url.includes('dev-channel') ? previous : '2.0.0-dev.2')});
  return {calls, run: () => publish({github: {rest: {repos: api}}, context: {repo}, fetch})};
}

test('production publishes only its version and never writes the Dev pointer', async () => {
  const s = await scenario('stable');
  await s.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][1].make_latest, 'true');
  assert.equal(s.calls[0][1].prerelease, false);
});

test('Dev versions and their pointer are never Latest', async () => {
  const s = await scenario('dev', '2.0.0-dev.1');
  await s.run();
  const updates = s.calls.filter(([method]) => method === 'update');
  assert.equal(updates.length, 2);
  for (const [, args] of updates) {
    assert.equal(args.prerelease, true);
    assert.equal(args.make_latest, 'false');
  }
  const upload = s.calls.find(([method]) => method === 'upload')[1];
  assert.equal(upload.release_id, 2);
  assert.equal(JSON.parse(upload.data.toString()).version, '2.0.0-dev.2');
});

test('out of order Dev builds cannot roll back the channel pointer', async () => {
  const s = await scenario('dev', '2.0.0-dev.10');
  await assert.rejects(s.run(), /回退/);
  assert.equal(s.calls.some(([method]) => method === 'delete' || method === 'upload'), false);
});
