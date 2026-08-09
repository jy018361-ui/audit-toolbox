const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../rules/ai_response.js');

assert.equal(AiResponse.messageContent({ content: '{"facts":[]}' }), '{"facts":[]}');
assert.equal(AiResponse.messageContent({
  content: [
    { type: 'text', text: '{"facts":' },
    { type: 'output_text', text: { value: '[]}' } }
  ]
}), '{"facts":[]}');
assert.equal(AiResponse.messageContent({ content: null }), '');

let requestBody = AiResponse.applyThinkingMode({ enable_thinking: true }, 'https://api.deepseek.com', 'deepseek-v4-flash', false);
assert.deepEqual(requestBody.thinking, { type: 'disabled' });
assert.equal(Object.hasOwn(requestBody, 'enable_thinking'), false);
requestBody = AiResponse.applyThinkingMode({}, 'https://api.deepseek.com', 'deepseek-v4-pro', true);
assert.deepEqual(requestBody.thinking, { type: 'enabled' });
requestBody = AiResponse.applyThinkingMode({}, 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', false);
assert.equal(requestBody.enable_thinking, false);
assert.equal(Object.hasOwn(requestBody, 'thinking'), false);

let error = AiResponse.emptyContentError({
  choices: [{
    finish_reason: 'length',
    message: { content: '', reasoning_content: '正在分析合同事实' }
  }]
}, '共享事实提取');
assert.equal(error.code, 'EMPTY_ASSISTANT_CONTENT');
assert.match(error.message, /共享事实提取返回正文为空/);
assert.match(error.message, /finish_reason=length/);
assert.match(error.message, /输出额度已用尽/);
assert.match(error.message, /思维内容8字/);
assert.match(error.message, /不会原样重复该长请求/);
assert.equal(error.finishReason, 'length');
assert.equal(error.reasoningLength, 8);

error = AiResponse.emptyContentError({ choices: [{ message: {} }] }, '合同提取');
assert.match(error.message, /当前模型或接口可能未执行/);

const appSource = fs.readFileSync(path.join(__dirname, '..', 'audipick.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.match(appSource, /var packageText=docs\.map/);
assert.match(appSource, /完整合同资料包/);
assert.match(appSource, /temperature:0,max_tokens:7000/);
assert.match(appSource, /applyThinkingMode\(body,A\.u,A\.m,false\)/);
assert.match(appSource, /aiExtractRevenueFactChunk\(doc,chunk,retries-1,true\)/);
assert.doesNotMatch(appSource, /\/no_think/);
assert.doesNotMatch(appSource, /splitRevenueText\(doc\.text/);
assert.match(mainSource, /signal: controller\.signal/);
assert.match(mainSource, /请求超时/);

console.log('AI response compatibility checks passed.');
