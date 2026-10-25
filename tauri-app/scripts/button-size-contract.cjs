// 仅检查页面显式声明的操作组，避免把上传热区、文件链接和候选卡误判。
function auditButtonSizes() {
  const issues = [];
  const heights = { default: 40, sm: 32 };
  for (const group of document.querySelectorAll('[data-button-size]')) {
    const expected = heights[group.dataset.buttonSize];
    if (!expected) continue;
    for (const button of group.querySelectorAll(':scope > [data-slot="button"]')) {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
      if (Math.abs(rect.height - expected) <= 1) continue;
      issues.push({
        kind: 'button-height-mismatch',
        selector: `[data-button-size="${group.dataset.buttonSize}"] > [data-slot="button"]`,
        detail: {
          text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
          expected, actual: Math.round(rect.height * 100) / 100,
        },
      });
    }
  }
  return issues;
}

module.exports = { auditButtonSizes };
