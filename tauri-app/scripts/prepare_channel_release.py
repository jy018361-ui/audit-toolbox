"""Validate a release ref and configure an isolated build (Python stdlib only)."""
import json
import os
from pathlib import Path
import re
import subprocess

VERSION = r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?"


def classify(tag):
    match = re.fullmatch("v" + VERSION, tag)
    if not match:
        raise ValueError("发布标签必须是 v 开头的语义版本号。")
    suffix = match[4]
    if suffix and any(not p or (p.isdigit() and len(p) > 1 and p[0] == '0') for p in suffix.split('.')):
        raise ValueError("预发布版本号格式无效。")
    if suffix and suffix.startswith('dev'):
        if not re.fullmatch(r'dev\.(0|[1-9]\d*)', suffix):
            raise ValueError("开发版标签必须使用 v主.次.修订-dev.序号。")
        return 'dev'
    return 'stable'


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def merge(base, override):
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        else:
            base[key] = value


def prepare(root, tag, channel):
    version = tag[1:]
    for relative in ['package.json', 'src-tauri/tauri.conf.json']:
        path = root / relative
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        data['version'] = version
        if relative.endswith('tauri.conf.json') and channel == 'dev':
            merge(data, json.loads((root / 'src-tauri/tauri.dev.conf.json').read_text(encoding='utf-8')))
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for relative, pattern in [
        ('src-tauri/Cargo.toml', r'(?m)^version = "[^"]+"'),
        ('scripts/build_tauri_release.py', r'(?m)^VERSION = "[^"]+"'),
    ]:
        path = root / relative
        text = path.read_text(encoding='utf-8-sig')
        replacement = ('VERSION' if relative.endswith('.py') else 'version') + f' = "{version}"'
        text, count = re.subn(pattern, replacement, text, count=1)
        if count != 1:
            raise ValueError(f'无法同步版本号：{relative}')
        path.write_text(text, encoding='utf-8')


def main():
    event = os.environ['GITHUB_EVENT_NAME']
    ref = os.environ['GITHUB_REF']
    tag = os.environ.get('INPUT_TAG', '') if event == 'workflow_dispatch' else os.environ['GITHUB_REF_NAME']
    channel = classify(tag)
    expected_branch = 'dev' if channel == 'dev' else 'main'
    if event == 'workflow_dispatch' and ref != f'refs/heads/{expected_branch}':
        raise ValueError(f'请在 {expected_branch} 分支手动发布此通道。')
    git('fetch', 'origin', f'+refs/heads/{expected_branch}:refs/remotes/origin/{expected_branch}')
    sha = git('rev-parse', 'HEAD')
    subprocess.run(['git', 'merge-base', '--is-ancestor', sha, f'origin/{expected_branch}'], check=True)
    existing = subprocess.run(['git', 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}'], capture_output=True, text=True)
    if existing.returncode == 0 and existing.stdout.strip() != sha:
        raise ValueError('该标签已指向其他提交，请使用新版本号。')
    prepare(Path(__file__).resolve().parents[1], tag, channel)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write(f'tag={tag}\nchannel={channel}\nsha={sha}\n')


if __name__ == '__main__':
    main()
