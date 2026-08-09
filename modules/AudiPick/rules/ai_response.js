(function (global) {
  'use strict';

  function textFromValue(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    if (value.text && typeof value.text.value === 'string') return value.text.value;
    if (typeof value.value === 'string') return value.value;
    return '';
  }

  function messageContent(message) {
    if (!message) return '';
    if (Array.isArray(message.content)) {
      return message.content.map(textFromValue).join('');
    }
    return textFromValue(message.content);
  }

  function apiHostname(base) {
    try { return new URL(String(base || '')).hostname.toLowerCase(); }
    catch (error) { return ''; }
  }

  function isDeepSeek(base, model) {
    return /(^|\.)api\.deepseek\.com$/i.test(apiHostname(base)) || /^deepseek-(?:v4|chat|reasoner)/i.test(String(model || ''));
  }

  function applyThinkingMode(body, base, model, enabled) {
    body = body || {};
    delete body.thinking;
    delete body.enable_thinking;
    if (isDeepSeek(base, model)) {
      body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    } else if (!enabled) {
      body.enable_thinking = false;
    }
    return body;
  }

  function emptyContentError(response, stage) {
    var choice = response && response.choices && response.choices[0] || {};
    var message = choice.message || {};
    var reasoning = textFromValue(message.reasoning_content || message.reasoning);
    var finishReason = String(choice.finish_reason || '').trim();
    var label = stage || 'AI提取';
    var detail = [];
    if (finishReason) detail.push('finish_reason=' + finishReason);
    if (reasoning) detail.push('思维内容' + reasoning.length + '字');
    if (finishReason === 'length') {
      detail.push('输出额度已用尽');
    }
    var suffix = detail.length ? '（' + detail.join('，') + '）' : '';
    var error = new Error(label + '返回正文为空' + suffix + '。程序已请求关闭思维模式，但当前模型或接口可能未执行；系统不会原样重复该长请求。');
    error.code = 'EMPTY_ASSISTANT_CONTENT';
    error.finishReason = finishReason;
    error.reasoningLength = reasoning.length;
    return error;
  }

  global.AiResponse = {
    messageContent: messageContent,
    emptyContentError: emptyContentError,
    isDeepSeek: isDeepSeek,
    applyThinkingMode: applyThinkingMode
  };
})(window);
