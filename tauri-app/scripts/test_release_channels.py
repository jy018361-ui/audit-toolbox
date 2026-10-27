import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare_channel_release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
ROOT = Path(__file__).resolve().parents[1]


class ReleaseChannels(unittest.TestCase):
    def test_tags_cannot_silently_select_the_wrong_channel(self):
        for tag in ['dev', 'main', 'v2.0', 'v2.0.0-dev', 'v2.0.0-dev.01', 'v2.0.0-dev.foo', 'v2.0.0-devil.1']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.classify(tag)
        self.assertEqual(release.classify('v2.0.0-dev.1'), 'dev')
        self.assertEqual(release.classify('v2.0.0-alpha.132'), 'stable')
        self.assertEqual(release.classify('v2.0.0'), 'stable')

    def test_builds_have_disjoint_endpoints_and_install_identities(self):
        results = {}
        for channel, tag in [('stable', 'v2.0.0-alpha.132'), ('dev', 'v2.0.0-dev.1')]:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                for relative in ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.dev.conf.json', 'src-tauri/Cargo.toml', 'scripts/build_tauri_release.py']:
                    target = root / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(ROOT / relative, target)
                release.prepare(root, tag, channel)
                config = json.loads((root / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
                self.assertEqual(config['version'], tag[1:])
                self.assertEqual(json.loads((root / 'package.json').read_text(encoding='utf-8'))['version'], tag[1:])
                self.assertIn(f'version = "{tag[1:]}"', (root / 'src-tauri/Cargo.toml').read_text(encoding='utf-8'))
                self.assertIn(f'VERSION = "{tag[1:]}"', (root / 'scripts/build_tauri_release.py').read_text(encoding='utf-8'))
                results[channel] = config
        for key in ['identifier', 'productName']:
            self.assertNotEqual(results['stable'][key], results['dev'][key])
        stable_url = results['stable']['plugins']['updater']['endpoints'][0]
        dev_url = results['dev']['plugins']['updater']['endpoints'][0]
        self.assertIn('/releases/latest/download/', stable_url)
        self.assertIn('/releases/download/dev-channel/', dev_url)
        self.assertNotEqual(stable_url, dev_url)
        self.assertEqual(results['stable']['plugins']['updater']['pubkey'], results['dev']['plugins']['updater']['pubkey'])


if __name__ == '__main__':
    unittest.main()
