# 组件 Token 规则

所有组件从 `.design/design-system.json` 取值。实现时先在 `:root` 映射 CSS 变量，再在组件中使用变量；组件样式不直接写裸色值。

## 按钮
- 默认按钮：surface 使用 `palette.surface.panel`，文字 `palette.text.body`，边框 `palette.border.default`，圆角 `radius.md`，高度 `layout.tableRowHeight`。
- 主要按钮：surface 使用 `palette.primary.600`，文字 `palette.text.inverse`，hover 使用 `palette.primary.700`，focus ring 使用 `palette.border.focus`。
- 次要按钮：surface 使用 `palette.surface.selected`，文字 `palette.primary.700`，边框 `palette.primary.200`。
- 幽灵按钮：surface 透明，文字 `palette.text.muted`，hover surface 使用 `palette.neutral.100`。
- 危险按钮：surface 使用 `palette.semantic.danger`，文字 `palette.text.inverse`。
- 尺寸：sm 高度 `32px`，md 使用 `layout.tableRowHeight`，lg 高度 `44px`；水平 padding 分别使用 `spacing.3`、`spacing.4`、`spacing.5`。
- 状态：hover 只改变 surface/border；active 使用轻微 translateY；disabled 使用 `palette.text.subtle`、`palette.neutral.100`，并禁用 pointer。

## 输入框 & 表单字段
- 默认：surface `palette.surface.panel`，文字 `palette.text.body`，placeholder `palette.text.subtle`，边框 `palette.border.default`，圆角 `radius.md`。
- focus：边框 `palette.border.focus`，ring 使用 `palette.primary.100`。
- error：边框和辅助文字使用 `palette.semantic.danger`。
- disabled/read-only：surface `palette.neutral.50`，文字 `palette.text.muted`。
- 高度：普通输入使用 `layout.tableRowHeight`；长文本区域最小高度按内容密度设定，但 padding 使用 `spacing.3`。

## 卡片
- 普通卡片：surface `palette.surface.panel`，border `palette.border.default`，radius `radius.lg`，shadow `shadow.sm`。
- 重要统计卡：surface `palette.surface.panelRaised`，border `palette.border.default`，shadow `shadow.md`。
- 可操作列表项：hover 使用 `palette.surface.subtle`，选中使用 `palette.surface.selected`。

## 导航
- 顶部栏：高度 `layout.headerHeight`，surface `palette.surface.panel`，底部分隔线 `palette.border.default`。
- 侧栏：宽度 `layout.sidebarWidth`，surface `palette.surface.panel`，active item 使用 `palette.surface.selected` + `palette.primary.700`。
- 设置入口与普通 tab 分组，保持在侧栏底部或独立区域。
- 导航标签使用 `typography.scale.sm`、`typography.weight.medium`。

## 右侧上下文面板
- 宽度 `layout.contextPanelWidth`，surface `palette.surface.panel`，border `palette.border.default`，radius `radius.lg`。
- 标题使用 `typography.scale.base` + `typography.weight.semibold`。
- 状态数字使用 tabular figures；路径、ID、时间使用 `typography.fontFamily.mono`。
- 面板内部使用 sticky header，明细区域独立滚动。

## 弹窗 / Dialog
- scrim 使用 `palette.surface.scrim`。
- dialog surface `palette.surface.panelRaised`，radius `radius.xl`，shadow `shadow.xl`。
- 标题使用 `typography.scale.lg` + `typography.weight.semibold`。
- destructive confirm 的主按钮使用危险按钮 token，取消按钮使用默认按钮 token。

## 表格 / 数据视图
- 表头 surface `palette.neutral.50`，文字 `palette.text.muted`，高度 `layout.tableRowHeight`。
- 行高使用 `layout.tableRowHeight`，行分隔线 `palette.border.subtle`。
- 斑马纹使用 `palette.surface.subtle`，hover 使用 `palette.surface.selected`。
- 状态列使用 badge token，不只依赖颜色，还保留中文状态文本。

## Toast / 提示
- 默认 toast：surface `palette.surface.console`，文字 `palette.text.inverse`，radius `radius.lg`，shadow `shadow.lg`。
- success/warning/danger/info 使用对应 `palette.semantic.*` 做左侧状态条或图标色。
- 自动消失时间使用 `motion.duration.slow` 做进出场，展示时间保持现有逻辑。

## 徽标 / 标签
- 普通标签：surface `palette.neutral.50`，border `palette.border.default`，文字 `palette.text.muted`，radius `radius.pill`。
- active/selected：surface `palette.surface.selected`，border `palette.primary.200`，文字 `palette.primary.700`。
- success/warning/danger/info 标签使用语义色的浅色面和深色文字映射；实现时从 palette 派生 CSS 变量，不在组件中写裸色值。
- 标签字号使用 `typography.scale.xs` 或 `typography.scale.sm`，高度不低于 `32px`。
