// Uses the app's real formatter with synthetic meeting content. No mailbox access.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ server: {middlewareMode:true}, appType:'custom' });
  try {
    const dom = new JSDOM('');
    for (const key of ['DOMParser','Node','Element']) globalThis[key] = dom.window[key];
    const { formatMeetingMinutes } = await server.ssrLoadModule('/src/meetingMinutesFormat.tsx');
    const markdown = `# 季度审计项目协调会（按内容）

## 一、会议信息
本邮件为合成样例，用于展示排版，不对应真实会议。

- 会议时间：2026年10月29日 10:00–10:30
- 参会人员：张三、李四、王五

## 二、讨论要点
### 底稿准备与复核
- 张三汇报：主要科目的标准审计工作底稿（SWP）已完成初稿，仍有部分支持性资料需要补充。
- 李四提出：本周先完成试算平衡表（TB）与会计分录（JE）的勾稽，再安排后续复核。
- 王五提醒：通过 PBC 收发存管理门户（CCP）集中跟进资料缺口，并保留交付记录。

### 资料交付与沟通
各科目负责人应汇总待补资料，明确资料名称、提供人和计划时间，避免重复索取。

## 三、会议结论
1. 先完成账表核对，再推进底稿复核。
2. 资料缺口统一收口，由现场负责人跟进。
3. 下次会议检查资料到位情况与复核问题处理进度。

## 四、后续事项
| 类型 | 事项 | 责任人 | 截止时间 | 交付结果 |
| --- | --- | --- | --- | --- |
| 待办 | 完成 TB 与 JE 勾稽核对 | 李四 | 10月30日 | 核对记录 |
| 待办 | 汇总并跟进 PBC 资料缺口 | 王五 | 10月30日 | 资料缺口清单 |
| 待办 | 组织底稿复核并跟进复核问题 | 张三 | 11月2日 | 已更新底稿 |
| 待确认 | 确认下一次复核会议时间 | 未提及 | 未提及 | 会议安排 |
`;
    const formatted = formatMeetingMinutes(markdown);
    const output = path.resolve('artifacts/meeting-mail-20261029');
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'会议纪要邮件样例.html'),formatted.html);
    fs.writeFileSync(path.join(output,'会议纪要邮件样例.txt'),formatted.text);
    fs.writeFileSync(path.join(output,'会议纪要合成样例.md'),markdown);
    fs.writeFileSync(path.join(output,'sample.json'),JSON.stringify(formatted,null,2));
    const base64 = text => Buffer.from(text,'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
    const boundary = 'audit-toolbox-synthetic-meeting-alternative';
    const eml = [
      `Subject: =?UTF-8?B?${Buffer.from(formatted.subject).toString('base64')}?=`,
      'X-Unsent: 1',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(formatted.text),
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(formatted.html),
      `--${boundary}--`, '',
    ].join('\r\n');
    fs.writeFileSync(path.join(output,'会议纪要邮件样例.eml'),eml);
    console.log(`样例已生成：${output}`);
  } finally { await server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
