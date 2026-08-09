const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadHubLlmSettings } = require('../hub_llm_bridge');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audipick-hub-llm-'));
const configDir = path.join(root, 'AuditToolbox');
fs.mkdirSync(configDir, { recursive: true });
const configFile = path.join(configDir, 'llm_settings.json');

fs.writeFileSync(configFile, JSON.stringify({
  enabled: true,
  api_type: 'openai',
  base_url: 'https://example.test/v1/',
  model: 'acceptance-model',
  api_key: 'acceptance-key',
  auth_mode: 'raw',
  thinking_enabled: true
}));
const valid = loadHubLlmSettings(root);
assert.strictEqual(valid.available, true);
assert.strictEqual(valid.u, 'https://example.test/v1');
assert.strictEqual(valid.m, 'acceptance-model');
assert.strictEqual(valid.authMode, 'raw');
assert.strictEqual(valid.think, true);

fs.writeFileSync(configFile, JSON.stringify({
  enabled: false,
  api_type: 'openai',
  base_url: 'https://example.test/v1',
  model: 'disabled-model',
  api_key: 'disabled-key'
}));
assert.strictEqual(loadHubLlmSettings(root).available, false);

fs.writeFileSync(configFile, JSON.stringify({
  enabled: true,
  api_type: 'dify_chat',
  base_url: 'https://example.test/v1',
  api_key: 'dify-key'
}));
assert.strictEqual(loadHubLlmSettings(root).available, false);

fs.rmSync(root, { recursive: true, force: true });
console.log('hub LLM bridge tests passed');
