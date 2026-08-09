# AudiPick 1.4.6

AudiPick 是一款基于 Electron 的智能合同审阅桌面工具，支持合同 OCR、条款提取、项目文件关联、收入合同审阅底稿、PDF 定位预览、模板管理和多主题界面。

本目录只包含可审阅的应用源代码、规则及自动化测试，不包含客户合同、底稿文件、API 密钥、本地用户数据、`node_modules`、生成的 `vendor` 依赖或安装包。

## 环境要求

- Windows 10/11
- Node.js 18+
- Python 3（仅用于 JavaScript 语法检查脚本）

## 安装与运行

```powershell
npm install
npm start
```

`npm install` 会通过 `postinstall` 将 PDF.js 和 Excel 依赖复制到本地 `vendor` 目录。

## 测试

```powershell
npm test
```

测试覆盖项目文件关联、AI响应兼容、收入合同审阅与底稿固定答案、借款合同审阅、项目看板、底稿读取、主题配置、后台续跑、导出命名和主页面脚本语法。

## 构建便携版

```powershell
npm run dist:portable
```

生成结果位于本地 `dist` 目录，该目录不纳入版本管理。

## 本地配置

AI 与 OCR 服务的地址、模型名称和密钥均由用户在应用内配置，并保存在本机。源码中不包含任何可用密钥。

当前版本提供黄黑、黄白、蓝白、红白、黄蓝、红黄米白、黄绿和青绿深色共八套主题，可在应用左下角的设置中切换。
