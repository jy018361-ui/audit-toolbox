// Production keeps /latest; Dev reads an explicit prerelease pointer.
function devParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)$/.exec(version);
  if (!match) throw new Error('开发更新清单版本格式无效。');
  return match.slice(1).map(BigInt);
}

function isNewer(next, previous) {
  const a = devParts(next), b = devParts(previous);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function validateManifest(manifest, tag, repo) {
  devParts(manifest.version);
  if (manifest.version !== tag.slice(1)) throw new Error('更新清单与发布版本不一致。');
  const platforms = Object.values(manifest.platforms || {});
  const prefix = `https://github.com/${repo.owner}/${repo.repo}/releases/download/${tag}/`;
  if (!platforms.length || platforms.some(p => !p || !p.signature || typeof p.url !== 'string' || !p.url.startsWith(prefix))) {
    throw new Error('开发更新必须指向本次发布的签名安装包。');
  }
}

function installerUrl(asset, tag, repo) {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
}

function normalizeManifest(manifest, release, tag, repo) {
  const normalized = JSON.parse(JSON.stringify(manifest));
  for (const platform of Object.values(normalized.platforms || {})) {
    if (!platform || typeof platform.url !== 'string') throw new Error('更新清单安装包地址无效。');
    const asset = release.assets.find(a => a.name.endsWith('.exe') &&
      (platform.url === a.url || platform.url === a.browser_download_url));
    if (!asset) throw new Error('更新清单引用的安装包不属于本次发布。');
    const draftPrefix = `https://github.com/${repo.owner}/${repo.repo}/releases/download/untagged-`;
    if (asset.browser_download_url !== installerUrl(asset, tag, repo) &&
        !(release.draft && asset.browser_download_url.startsWith(draftPrefix))) {
      throw new Error('安装包下载地址不属于本次发布仓库。');
    }
    // Draft assets can expose temporary untagged URLs until publication.
    platform.url = installerUrl(asset, tag, repo);
  }
  validateManifest(normalized, tag, repo);
  return normalized;
}

async function assetText(github, repo, asset) {
  const {data} = await github.rest.repos.getReleaseAsset({
    ...repo, asset_id: asset.id, headers: {accept: 'application/octet-stream'},
  });
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  throw new Error(`无法读取发布附件：${asset.name}`);
}

async function loadManifest(github, repo, release, tag) {
  const asset = release.assets.find(a => a.name === 'latest.json');
  if (!asset) throw new Error('安装包更新清单缺失，保留当前发布状态。');
  const original = JSON.parse(await assetText(github, repo, asset));
  const manifest = normalizeManifest(original, release, tag, repo);
  for (const platform of Object.values(manifest.platforms)) {
    const installer = release.assets.find(a => a.name.endsWith('.exe') && installerUrl(a, tag, repo) === platform.url);
    const signature = release.assets.find(a => a.name === `${installer.name}.sig`);
    if (!signature || (await assetText(github, repo, signature)).trim() !== platform.signature.trim()) {
      throw new Error('更新清单签名与本次安装包签名附件不一致。');
    }
  }
  return {asset, original, manifest};
}

async function uploadManifest(github, repo, releaseId, manifest) {
  const data = Buffer.from(JSON.stringify(manifest));
  await github.rest.repos.uploadReleaseAsset({
    ...repo, release_id: releaseId, name: 'latest.json', data,
    headers: {'content-type': 'application/json', 'content-length': data.length},
  });
}

async function normalizeReleaseAsset(github, repo, release, loaded) {
  if (JSON.stringify(loaded.original) === JSON.stringify(loaded.manifest)) return;
  if (release.immutable) throw new Error('发布不可变，无法修正安装包更新清单。');
  await github.rest.repos.deleteReleaseAsset({...repo, asset_id: loaded.asset.id});
  await uploadManifest(github, repo, release.id, loaded.manifest);
}

function samePlatforms(a, b) {
  // Ignore key order, but require every platform and its full update payload to agree.
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

async function syncDevChannel({github, repo, tag, manifest, allowSameVersion}) {
  let pointer;
  try {
    ({data: pointer} = await github.rest.repos.getReleaseByTag({...repo, tag: 'dev-channel'}));
  } catch (error) {
    if (error.status !== 404) throw error;
    ({data: pointer} = await github.rest.repos.createRelease({
      ...repo, tag_name: 'dev-channel', target_commitish: process.env.RELEASE_SHA || tag,
      name: '开发版自动更新通道', body: '仅供 Dev 程序检查更新。安装包及更新说明请查看各 dev 版本。',
      prerelease: true, draft: true, make_latest: 'false',
    }));
  }
  if (!pointer.prerelease || pointer.immutable) throw new Error('dev-channel 必须是可更新的预发布通道。');
  const asset = pointer.assets.find(a => a.name === 'latest.json');
  if (asset) {
    const previous = JSON.parse(await assetText(github, repo, asset));
    if (allowSameVersion && manifest.version === previous.version) {
      validateManifest(previous, tag, repo);
      if (!samePlatforms(manifest.platforms, previous.platforms)) throw new Error('同版本开发通道的安装包或签名不一致，拒绝覆盖。');
      if (pointer.draft) await github.rest.repos.updateRelease({
        ...repo, release_id: pointer.id, draft: false, prerelease: true, make_latest: 'false',
      });
      return;
    }
    if (!isNewer(manifest.version, previous.version)) throw new Error('拒绝将开发通道回退或覆盖到相同版本。');
    await github.rest.repos.deleteReleaseAsset({...repo, asset_id: asset.id});
  }
  await uploadManifest(github, repo, pointer.id, manifest);
  await github.rest.repos.updateRelease({
    ...repo, release_id: pointer.id, draft: false, prerelease: true, make_latest: 'false',
  });
}

async function getVersionRelease(github, repo, tag) {
  const args = {...repo};
  const releaseId = process.env.RELEASE_ID;
  const {data} = releaseId ? await github.rest.repos.getRelease({...args, release_id: Number(releaseId)}) :
    await github.rest.repos.getReleaseByTag({...args, tag});
  if (data.tag_name !== tag) throw new Error('发布对象与本次版本不一致。');
  return data;
}

async function publish({github, context}) {
  const repo = context.repo;
  const tag = process.env.RELEASE_TAG;
  const dev = process.env.RELEASE_CHANNEL === 'dev';
  if (!['dev', 'stable'].includes(process.env.RELEASE_CHANNEL)) throw new Error('未知发布通道。');
  if (dev !== /^v\d+\.\d+\.\d+-dev\.\d+$/.test(tag)) throw new Error('发布标签与更新通道不一致。');
  const release = await getVersionRelease(github, repo, tag);
  if (!release.draft) throw new Error('发布对象必须是本次版本的草稿。');
  if (!release.assets.some(a => a.name === 'latest.json') || !release.assets.some(a => a.name.endsWith('.exe.sig'))) {
    throw new Error('安装包更新清单或签名缺失，保留草稿。');
  }
  let loaded;
  if (dev) {
    loaded = await loadManifest(github, repo, release, tag);
    await normalizeReleaseAsset(github, repo, release, loaded);
  }
  await github.rest.repos.updateRelease({
    ...repo, release_id: release.id, draft: false, prerelease: dev,
    make_latest: dev ? 'false' : 'true',
  });
  if (dev) await syncDevChannel({github, repo, tag, manifest: loaded.manifest, allowSameVersion: false});
}

async function repairDevChannel({github, context}) {
  const repo = context.repo, tag = process.env.RELEASE_TAG;
  if (!/^v\d+\.\d+\.\d+-dev\.\d+$/.test(tag)) throw new Error('仅允许修复 Dev 预发布通道。');
  const release = await getVersionRelease(github, repo, tag);
  if (release.draft || !release.prerelease) throw new Error('仅允许修复已公开的 Dev 预发布版本。');
  const loaded = await loadManifest(github, repo, release, tag);
  await normalizeReleaseAsset(github, repo, release, loaded);
  await syncDevChannel({github, repo, tag, manifest: loaded.manifest, allowSameVersion: true});
}

module.exports = publish;
module.exports.repairDevChannel = repairDevChannel;
module.exports.isNewer = isNewer;
module.exports.validateManifest = validateManifest;
module.exports.normalizeManifest = normalizeManifest;
