# 风格选择

**选定预设**：Data-Dense Dashboard

**理由**：这个页面的核心不是展示品牌，而是高频审核、检索、处理队列和诊断状态。`Data-Dense Dashboard` 匹配“极简 + 科技”的要求：信息密度高、网格清晰、状态明确、适合表格和队列，同时可以保持克制的专业控制台气质。

## 配色：Light Developer Console

采用浅色主界面：白色/浅灰承载长文本审核，蓝色作为主操作和选中态，绿色表示成功/可用，红色表示危险操作，琥珀色表示警告。深色只用于 toast、代码感状态片段或局部强调，不做全站暗黑。

预览：
- 主背景：`palette.surface.app`
- 面板：`palette.surface.panel`
- 主操作：`palette.primary.600`
- 成功状态：`palette.semantic.success`
- 危险操作：`palette.semantic.danger`
- 技术强调：`palette.accent.500`

## 字体搭配：Chinese Professional Console

- 标题：`typography.fontFamily.heading`
- 正文：`typography.fontFamily.body`
- ID / 路径 / 时间 / 队列状态：`typography.fontFamily.mono`

选择依据：`ui-ux-pro-max` 推荐了 `Chinese Simplified` 和 `Dashboard Data` 两组方向。最终采用中文系统字体为主体，保证中文长文本阅读和本地分发稳定；等宽字体只用于技术元数据，避免整页变成代码编辑器。

## 取舍说明

- `Data-Dense Dashboard` vs `Executive Dashboard`：选择前者，因为审核台和知识库需要扫读大量条目，不是只看 4-6 个高层 KPI。
- `Data-Dense Dashboard` vs `Swiss Modernism 2.0`：选择前者，因为 Swiss 更适合文档/官网，当前页面需要表单、队列、列表和状态面板的高密度操作。
- 暗色代码风 vs 浅色控制台：保留浅色控制台。`ui-ux-pro-max` 对 developer dashboard 倾向暗色，但本产品要长时间审核中文内容，浅色更稳。

## 备选方向（用户想换风格时备用）

1. 深色科技台：更接近 performativeUI，适合 Demo，但长文本审核更累。
2. Swiss Modernism 2.0：更极简、更文档化，适合产品官网或设置页，但主工作台信息密度不足。
