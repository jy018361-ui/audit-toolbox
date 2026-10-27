const {test} = require('node:test');
const assert = require('node:assert/strict');
const publish = require('./publish_channel_release.cjs');
const repo = {owner: 'example', repo: 'toolbox'};
const version = '2.0.0-dev.2';
const tag = `v${version}`;
const manifest = value => ({version: value, platforms: {'windows-x86_64': {
  signature: 'signed', url: `https://github.com/example/toolbox/releases/download/v${value}/setup.exe`,
}}});
const installer = {
  id: 10, name: 'setup.exe', url: 'https://api.github.com/repos/example/toolbox/releases/assets/10',
  browser_download_url: manifest(version).platforms['windows-x86_64'].url,
};

test('development versions compare numerically and reject other channels', () => {
  assert.equal(publish.isNewer('2.0.0-dev.10', '2.0.0-dev.9'), true);
  assert.equal(publish.isNewer('2.0.0-dev.1', '2.0.0-dev.2'), false);
  assert.equal(publish.isNewer('2.0.0-dev.2', '2.0.0-dev.2'), false);
  assert.throws(() => publish.isNewer('2.0.0', '2.0.0-dev.2'));
  assert.throws(() => publish.validateManifest(manifest('2.0.0-dev.1'), tag, repo));
  const wrong = manifest(version);
  wrong.platforms['windows-x86_64'].url = 'https://github.com/example/toolbox/releases/latest/download/setup.exe';
  assert.throws(() => publish.validateManifest(wrong, tag, repo));
});

test('API download URLs require an exact current-release installer match and become public URLs', () => {
  const input = manifest(version);
  input.platforms['windows-x86_64'].url = installer.url;
  assert.deepEqual(publish.normalizeManifest(input, {assets: [installer]}, tag, repo), manifest(version));
  assert.equal(input.platforms['windows-x86_64'].url, installer.url, 'input is not mutated');
  for (const url of [
    installer.url + '0', installer.url + '?download=1',
    installer.url.replace('example/toolbox', 'other/repo'),
    installer.browser_download_url.replace(tag, 'v2.0.0-dev.1'),
    installer.browser_download_url.replace('setup.exe', 'missing.exe'), undefined,
  ]) {
    input.platforms['windows-x86_64'].url = url;
    assert.throws(() => publish.normalizeManifest(input, {assets: [installer]}, tag, repo));
  }
  input.platforms['windows-x86_64'].url = installer.url;
  const foreign = {...installer, browser_download_url: installer.browser_download_url.replace('example/toolbox', 'other/repo')};
  assert.throws(() => publish.normalizeManifest(input, {assets: [foreign]}, tag, repo));
});

function scenario(options = {}) {
  const calls = [];
  const channel = options.channel || 'dev';
  const releaseTag = channel === 'dev' ? tag : 'v2.0.0-alpha.132';
  Object.assign(process.env, {RELEASE_CHANNEL: channel, RELEASE_TAG: releaseTag, RELEASE_ID: '1', RELEASE_SHA: 'abc'});
  const release = {id: 1, draft: !options.repair, prerelease: true, tag_name: releaseTag,
    assets: [installer, {id: 11, name: 'setup.exe.sig'}, {id: 12, name: 'latest.json'}], ...options.release};
  const source = structuredClone(options.source || manifest(version));
  if (options.apiUrl) source.platforms['windows-x86_64'].url = installer.url;
  const pointer = {id: 2, tag_name: 'dev-channel', prerelease: true, draft: false,
    assets: options.previous ? [{id: 20, name: 'latest.json'}] : [], ...options.pointer};
  const bytes = text => options.encoding === 'string' ? text :
    options.encoding === 'arraybuffer' ? Uint8Array.from(Buffer.from(text)).buffer : Buffer.from(text);
  const api = {
    getRelease: async args => { assert.equal(args.owner, repo.owner); assert.equal(args.repo, repo.repo); return {data: release}; },
    getReleaseAsset: async args => {
      assert.equal(args.headers.accept, 'application/octet-stream');
      assert.equal(args.owner, repo.owner); assert.equal(args.repo, repo.repo);
      const text = args.asset_id === 12 ? JSON.stringify(source) : args.asset_id === 11 ? options.signature || 'signed\n' :
        args.asset_id === 20 ? JSON.stringify(typeof options.previous === 'string' ? manifest(options.previous) : options.previous) : null;
      assert.notEqual(text, null, 'only metadata and signature attachments should be read');
      return {data: bytes(text)};
    },
    updateRelease: async args => { calls.push(['update', args]); return {data: args}; },
    getReleaseByTag: async args => {
      if (args.tag !== 'dev-channel') { assert.equal(args.tag, releaseTag); return {data: release}; }
      if (options.noPointer) throw Object.assign(new Error('missing'), {status: 404});
      return {data: pointer};
    },
    createRelease: async args => { calls.push(['create', args]); return {data: {...pointer, draft: true}}; },
    deleteReleaseAsset: async args => { calls.push(['delete', args]); },
    uploadReleaseAsset: async args => { calls.push(['upload', args]); },
  };
  const args = {github: {rest: {repos: api}}, context: {repo}};
  return {calls, run: () => options.repair ? publish.repairDevChannel(args) : publish(args)};
}

test('production publishes only its version and never writes the Dev pointer', async () => {
  const s = scenario({channel: 'stable'});
  await s.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][1].make_latest, 'true');
  assert.equal(s.calls[0][1].prerelease, false);
});

test('Dev draft API URLs and signatures are validated and rewritten before it is public', async () => {
  const s = scenario({apiUrl: true, previous: '2.0.0-dev.1'});
  await s.run();
  assert.deepEqual(s.calls.map(([method, args]) => [method, args.release_id || args.asset_id]),
    [['delete', 12], ['upload', 1], ['update', 1], ['delete', 20], ['upload', 2], ['update', 2]]);
  for (const [method, args] of s.calls) {
    if (method === 'update') { assert.equal(args.prerelease, true); assert.equal(args.make_latest, 'false'); }
    if (method === 'upload') assert.deepEqual(JSON.parse(args.data.toString()), manifest(version));
  }
});

test('invalid source URL or signature leaves the draft untouched', async () => {
  const bad = manifest(version);
  bad.platforms['windows-x86_64'].url = installer.url + '999';
  for (const options of [{source: bad}, {signature: 'different'}, {release: {assets: [installer, {id: 12, name: 'latest.json'}]}}]) {
    const s = scenario(options);
    await assert.rejects(s.run());
    assert.deepEqual(s.calls, []);
  }
});

test('out of order Dev builds cannot roll back the channel pointer', async () => {
  const s = scenario({previous: '2.0.0-dev.10'});
  await assert.rejects(s.run(), /回退/);
  assert.equal(s.calls.some(([method]) => method === 'delete' || method === 'upload'), false);
});

test('repair normalizes the public version and creates only a prerelease Dev pointer', async () => {
  const s = scenario({repair: true, apiUrl: true, noPointer: true});
  delete process.env.RELEASE_ID; // Manual repair can find the version by tag.
  await s.run();
  assert.equal(s.calls.some(([method, args]) => method === 'update' && args.release_id === 1), false);
  assert.deepEqual(s.calls.filter(([method]) => method === 'upload').map(([, args]) => args.release_id), [1, 2]);
  for (const [method, args] of s.calls) {
    if (['create', 'update'].includes(method)) { assert.equal(args.prerelease, true); assert.equal(args.make_latest, 'false'); }
  }
});

test('repair is idempotent for matching platforms regardless of object property order', async () => {
  const previous = manifest(version);
  previous.platforms['windows-x86_64'] = {url: installer.browser_download_url, signature: 'signed'};
  const s = scenario({repair: true, previous});
  await s.run();
  assert.deepEqual(s.calls, []);
});

test('repair refuses changed platforms at the same version and newer channel versions', async () => {
  const previous = manifest(version);
  previous.platforms['windows-x86_64'].signature = 'changed';
  for (const value of [previous, '2.0.0-dev.10']) {
    const s = scenario({repair: true, previous: value});
    await assert.rejects(s.run(), /不一致|回退/);
    assert.deepEqual(s.calls, []);
  }
});

test('repair rejects stable labels, drafts, non-prereleases and mismatched release IDs', async () => {
  for (const options of [{channel: 'stable'}, {release: {draft: true}}, {release: {prerelease: false}}, {release: {tag_name: 'v2.0.0-dev.1'}}]) {
    const s = scenario({repair: true, ...options});
    await assert.rejects(s.run());
    assert.deepEqual(s.calls, []);
  }
});

test('repair refuses immutable or production channel pointer releases', async () => {
  for (const pointer of [{immutable: true}, {prerelease: false}]) {
    const s = scenario({repair: true, pointer});
    await assert.rejects(s.run(), /可更新/);
    assert.deepEqual(s.calls, []);
  }
});

test('asset reads support string, Buffer and ArrayBuffer responses', async () => {
  for (const encoding of ['string', 'buffer', 'arraybuffer']) {
    const s = scenario({repair: true, previous: version, encoding});
    await s.run();
    assert.deepEqual(s.calls, []);
  }
});
