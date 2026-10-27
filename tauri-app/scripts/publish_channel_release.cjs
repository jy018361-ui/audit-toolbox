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
  if (!platforms.length || platforms.some(p => !p.signature || !p.url?.startsWith(prefix))) {
    throw new Error('开发更新必须指向本次发布的签名安装包。');
  }
}

async function readManifest(fetch, url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`无法读取更新清单：HTTP ${response.status}`);
  return response.json();
}

async function publish({github, context, fetch}) {
  const repo = context.repo;
  const tag = process.env.RELEASE_TAG;
  const dev = process.env.RELEASE_CHANNEL === 'dev';
  if (!['dev', 'stable'].includes(process.env.RELEASE_CHANNEL)) throw new Error('未知发布通道。');
  if (dev !== /^v\d+\.\d+\.\d+-dev\.\d+$/.test(tag)) throw new Error('发布标签与更新通道不一致。');
  const releaseId = Number(process.env.RELEASE_ID);
  const {data: release} = await github.rest.repos.getRelease({...repo, release_id: releaseId});
  if (release.tag_name !== tag || !release.draft) throw new Error('发布对象必须是本次版本的草稿。');
  if (!release.assets.some(a => a.name === 'latest.json') || !release.assets.some(a => a.name.endsWith('.exe.sig'))) {
    throw new Error('安装包更新清单或签名缺失，保留草稿。');
  }
  await github.rest.repos.updateRelease({
    ...repo, release_id: releaseId, draft: false, prerelease: dev,
    make_latest: dev ? 'false' : 'true',
  });
  if (!dev) return;

  const base = `https://github.com/${repo.owner}/${repo.repo}/releases/download/`;
  const manifest = await readManifest(fetch, `${base}${tag}/latest.json`);
  validateManifest(manifest, tag, repo);
  let pointer;
  try {
    ({data: pointer} = await github.rest.repos.getReleaseByTag({...repo, tag: 'dev-channel'}));
  } catch (error) {
    if (error.status !== 404) throw error;
    ({data: pointer} = await github.rest.repos.createRelease({
      ...repo, tag_name: 'dev-channel', target_commitish: process.env.RELEASE_SHA,
      name: '开发版自动更新通道', body: '仅供 Dev 程序检查更新。安装包及更新说明请查看各 dev 版本。',
      prerelease: true, draft: true, make_latest: 'false',
    }));
  }
  if (!pointer.prerelease || pointer.immutable) throw new Error('dev-channel 必须是可更新的预发布通道。');
  const asset = pointer.assets.find(a => a.name === 'latest.json');
  if (asset) {
    const previous = await readManifest(fetch, `${base}dev-channel/latest.json`);
    if (!isNewer(manifest.version, previous.version)) throw new Error('拒绝将开发通道回退或覆盖到相同版本。');
    await github.rest.repos.deleteReleaseAsset({...repo, asset_id: asset.id});
  }
  const data = Buffer.from(JSON.stringify(manifest));
  await github.rest.repos.uploadReleaseAsset({
    ...repo, release_id: pointer.id, name: 'latest.json', data,
    headers: {'content-type': 'application/json', 'content-length': data.length},
  });
  await github.rest.repos.updateRelease({
    ...repo, release_id: pointer.id, draft: false, prerelease: true, make_latest: 'false',
  });
}

module.exports = publish;
module.exports.isNewer = isNewer;
module.exports.validateManifest = validateManifest;
