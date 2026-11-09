// 按 JSX 操作组精确修改，不触及事件处理、文案和业务状态。
const ts = require('typescript');
const fs = require('node:fs');
const files = [
  'src/FaListPage.tsx', 'src/FaPolicyComparePage.tsx', 'src/FaDepCalcPage.tsx',
  'src/FileListDirectoryPage.tsx', 'src/ConfirmationProgressPage.tsx',
  'src/TsManagerParityPage.tsx', 'src/KanzhangParityPage.tsx',
  'src/components/LedgerSourceCard.tsx', 'src/JeSignMarkPage.tsx', 'src/PdfToExcelPage.tsx',
];
for (const file of files) {
  let source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const groups = new Map();
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button') {
      let parent = node.parent;
      while (parent && !ts.isJsxElement(parent)) parent = parent.parent;
      if (parent) {
        const cls = parent.openingElement.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.text === 'className');
        const name = cls?.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : '';
        // 排除行内 LLM 采纳/撤销的 compact 组；PDF 文件选择工具条也保留 sm。
        const ordinary = name.split(' ').includes('actions') && !name.split(' ').includes('compact');
        const ledger = name === 'kz-actions';
        const shuttle = file.endsWith('KanzhangParityPage.tsx') && name === 'kz-source-actions';
        if (ordinary || ledger || shuttle) {
          if (!groups.has(parent)) groups.set(parent, {size: shuttle ? 'sm' : 'default', buttons: []});
          groups.get(parent).buttons.push(node.openingElement);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const edits = [];
  for (const [parent, group] of groups) {
    const marker = parent.openingElement.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.text === 'data-button-size');
    if (!marker) edits.push({start: parent.openingElement.end - 1, end: parent.openingElement.end - 1, text: ` data-button-size="${group.size}"`});
    for (const button of group.buttons) {
      const size = button.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.text === 'size');
      if (size?.initializer?.getText(ast) === '"sm"' && group.size === 'default') {
        edits.push({start: size.initializer.getStart(ast), end: size.initializer.end, text: '"default"'});
      } else if (!size && group.size === 'sm') {
        edits.push({start: button.end - 1, end: button.end - 1, text: ' size="sm"'});
      }
    }
  }
  for (const edit of edits.sort((a,b) => b.start - a.start)) source = source.slice(0,edit.start) + edit.text + source.slice(edit.end);
  fs.writeFileSync(file, source);
  console.log(`${file}: ${groups.size} 组，${edits.length} 处尺寸/标记修改`);
}
