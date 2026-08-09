# Audit Roll Forward

Audit Roll Forward 用于将公司标准 V6 审计底稿从上年度结转到本年度。工具可按项目和公司批量处理底稿，更新年度、资产负债表日、公司名称等基础信息，迁移期初数据、部分明细与公式、可复用的审计 wording，以及 CRA 科目、认定和风险等级，并将需要项目组复核的区域标记为黄色。

## 当前支持科目

- C 货币资金
- J1 在建工程
- K1 固定资产
- L1 无形资产
- L2 长期待摊费用
- M 应付票据
- N 应付账款
- Q1 银行借款
- U_exp 财务费用
- U_exp VC&VD 销售费用及管理费用

## 运行

```powershell
pip install -r requirements.txt
python main_gui.py
```

`main.py` 是 audit-toolbox 的适配入口，提供 `main(parent=None)`。

## 模板与资源

本公共仓库仅保存可审阅源码，不包含公司 V6 底稿模板、Logo、图标、客户底稿、CRA 数据或生成结果。请通过公司内部渠道取得以下目录，并放在本模块根目录：

```text
assets/
templates/
```

`templates/` 中的文件名应与 `subjects_config.json` 的 `template_file` 一致。缺少模板时，程序会提示“找不到模板目录”或对应模板文件。

## 使用范围

1. 仅适用于公司标准底稿模板的 Roll Forward（内置 V6 底稿模板）；若 Sheet 名称、表头或底稿结构被大幅修改，可能无法正确识别。
2. 上年底稿须为 `.xlsx` 格式，建议单个文件小于 20MB。
3. 参考处理时间：5MB 以内通常约 10 秒至 1 分钟；5–10MB 通常约 1 至 3 分钟；10–20MB 通常约 3 至 10 分钟；超过 20MB 可能需要更长时间，复杂文件可能超过 20 分钟。实际时间还会受到工作表数量、公式、图片及明细行数影响。
4. CRA 粘贴内容至少应包含科目名称、认定、风险等级；风险比例和“是否适用”列可不提供。
5. CRA 科目名称应清晰，例如货币资金、固定资产、管理费用、销售费用等。
6. 使用前请关闭正在打开的相关 Excel 文件，避免文件占用导致生成失败。
7. 测试版工具生成后，项目组需复核金额、公式、CRA 及黄色标记内容。

## 数据安全

- 不得向仓库提交客户底稿、客户名称、项目编号、CRA 原始内容或生成结果。
- API Key 和访问 Token 仅通过运行时输入或环境变量提供，不写入源码。
- `app_settings.py` 的主题和偏好设置仅保存在本机用户配置目录。

## 验证

```powershell
python -m py_compile main.py main_gui.py app_settings.py roll_forward_core.py roll_worker_process.py cra_support.py llm_enhancement.py dialog_helper.py
python settings_smoke_check.py
```
