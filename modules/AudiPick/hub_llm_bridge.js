const fs = require('fs');
const path = require('path');

function loadHubLlmSettings(appDataRoot) {
  const result = { available: false, source: 'hub' };
  if (!appDataRoot) return Object.assign(result, { reason: 'APPDATA unavailable' });

  const settingsFile = path.join(appDataRoot, 'AuditToolbox', 'llm_settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!raw || raw.enabled !== true) {
      return Object.assign(result, { reason: 'Hub LLM is disabled' });
    }
    if ((raw.api_type || 'openai') !== 'openai') {
      return Object.assign(result, {
        reason: 'AudiPick currently requires an OpenAI-compatible Hub endpoint'
      });
    }

    const apiKey = String(raw.api_key || '').trim();
    const baseUrl = String(raw.base_url || '').trim().replace(/\/+$/, '');
    const model = String(raw.model || '').trim();
    if (!apiKey || !baseUrl || !model) {
      return Object.assign(result, { reason: 'Hub LLM settings are incomplete' });
    }

    return {
      available: true,
      source: 'hub',
      k: apiKey,
      u: baseUrl,
      m: model,
      think: Boolean(raw.thinking_enabled),
      authMode: raw.auth_mode === 'raw' ? 'raw' : 'bearer'
    };
  } catch (error) {
    return Object.assign(result, {
      reason: error && error.code === 'ENOENT' ? 'Hub LLM settings not found' : 'Hub LLM settings unreadable'
    });
  }
}

module.exports = { loadHubLlmSettings };
