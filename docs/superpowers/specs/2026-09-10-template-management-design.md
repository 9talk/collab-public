# 模板管理功能 · 设计

日期：2026-09-10
状态：待评审

## 1. 背景与目标

用户维护了一套目录结构化的模板（类似脚手架），如 CLAUDE.md、rules/、skills/、src/ 等，用于快速初始化新项目。目前只能手动在 Finder 里操作，缺少：

- 模板库的浏览与管理（新建 / 重命名 / 删除模板及其内部结构）
- 把模板内容挂载到 workspace 的能力（软链接，源改动实时反映）
- 直观的拖拽挂载交互，替代手动 `ln -s`

目标：在 Collaborator 内提供模板管理窗口，支持把模板整体 / 任意目录 / 任意文件拖到 nav 的 workspace 树上，自动建立软链接。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 模板库（Templates Root） | 应用数据目录下的固定目录：`<COLLAB_DIR>/templates`（日常为 `~/.collab/templates`，dev 模式下随 COLLAB_DIR 隔离到 worktree 目录） |
| 模板（Template） | 模板库下的一个一级子目录（如 VUE-SHADCN、JAVA-DDD、common） |
| 挂载（Mount） | 在 workspace 内创建指向模板库内容的软链接 |
| 挂载节点（Link Node） | workspace 文件树中指向模板库的软链接节点 |

## 3. 范围

### In scope

- 模板管理窗口：单页双栏（模板列表 + 文件树），结构管理，外部编辑器打开
- 拖拽挂载：模板节点 → nav workspace 树，建立软链接
- 右键「挂载到…」等价入口（拖拽的兜底路径，必须实现）
- nav 中挂载节点的标识、来源跳转、卸载
- 窗口惰性创建、关闭即销毁、尺寸记忆

### Out of scope（明确不做）

- 硬链接（已决策：统一软链接）
- 模板内文件的内容编辑（只用外部编辑器打开）
- 多模板库根目录（固定单一根）
- 模板预览栏（三栏布局）、模板参数化 / 变量替换
- 从现有 workspace 反向保存为模板
- 旧目录 `~/claude-docs/templates` 的自动迁移（用户自行拷贝）

## 4. 架构

### 4.1 组件与数据流

```text
┌────────────── 主进程（扩展现有 RPC 体系）─────────────────┐
│  templates-rpc（新增）              drag-session 协调器（新增）│
│   · templates.list / tree           · 拖拽开始/结束登记      │
│   · templates.create / rename / rm  · 载荷查询（nav 悬停用） │
│   · templates.createNode / renameNode / deleteNode          │
│   · templates.openExternal / reveal · link.check（冲突预检） │
│   · link.create（唯一建链写口） · link.remove（卸载）        │
│   · 确认框（Electron 原生 dialog，modal 于主窗口）           │
└──────┬──────────────────────────────────┬─────────────────┘
       │ fs: <COLLAB_DIR>/templates（源）    │ fs: workspace 内（软链接）
┌──────┴──────────────┐          ┌────────┴────────────────────────┐
│ 模板管理窗口（新增）  │   拖拽   │ 主窗口 shell → nav（扩展）        │
│ 独立 BrowserWindow   │  ⇢⇢⇢⇢⇢  │ · 拖拽悬停高亮 + 落点提示         │
│ React 单页双栏       │          │ · 🔗 挂载节点 + 右键卸载/来源跳转 │
│ · 模板列表 + 文件树   │          │ · nav 入口按钮「🧩 模板」         │
│ · drag 源 / 结构管理 │          │                                  │
└─────────────────────┘          └──────────────────────────────────┘
```

### 4.2 关键设计决策

1. **建链唯一走主进程**：渲染窗口不直接操作文件系统；目标存在性、冲突、路径合法性（必须落在 workspace 根内 / 模板库根内）全部在主进程校验。
2. **拖拽 = 主进程协调的 drag-session**：dataTransfer 仅携带拖拽类型标记（跨进程沙箱下数据不可靠），实际载荷由主进程登记、nav 通过 RPC/事件获取，用于悬停预览与放置处理。
3. **确认框用 Electron 原生 dialog**（`dialog.showMessageBox`，modal 到主窗口）：跨窗口协调最简单稳妥，与「退出确认」的既有风格一致；支持「以后不再询问」checkbox。
4. **模板窗口为独立 BrowserWindow**：惰性创建（首次打开时）、已存在则 focus、closed 即销毁置空；窗口位置/尺寸记忆存全局 pref。
5. **外部编辑器复用**：打开模板文件/目录走现有 `external-editor.ts`（`openFileInEditor` / `openWorkspaceInEditor`），未配置外部编辑器时沿用现有 system-app 兜底行为。

### 4.3 涉及文件

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| 新增 | `src/main/templates-rpc.ts` | 模板与链接的全部 RPC 方法 |
| 新增 | `src/main/templates-rpc.test.ts` | 冲突矩阵 / 路径安全 / fs 操作测试 |
| 新增 | `src/windows/templates/` | 模板窗口 renderer（index.html + React） |
| 新增 | `src/preload/templates.ts` | 模板窗口 preload（`window.templatesApi`） |
| 修改 | `src/main/paths.ts` | 导出 `TEMPLATES_DIR = join(COLLAB_DIR, "templates")` |
| 修改 | `src/main/json-rpc-server.ts` | 注册 templates-rpc |
| 修改 | `src/main/index.ts` | 窗口创建/销毁 + nav 入口 IPC + 拖拽协调 |
| 修改 | `electron.vite.config.ts` | renderer input 注册 templates 窗口；preload input 注册 templates |
| 修改 | `src/windows/nav/` | 挂载节点渲染、右键菜单、拖拽接收、入口按钮 |
| 修改 | `src/main/files.ts`（或树数据源） | 节点附加 `isSymlink` / `linkTarget` 字段 |

## 5. 模板窗口设计

### 5.1 布局（单页双栏）

```text
┌─ 模板库 ──────────────── [🔄] [在访达打开] [+ 新建模板] ─┐
│ ┌────────────┬───────────────────────────────────────┐ │
│ │ VUE-SHADCN │ ▾ VUE-SHADCN                          │ │
│ │ VUE        │   ├ 📄 CLAUDE.md                      │ │
│ │ JAVA-DDD   │   ▾ 📁 rules/                         │ │
│ │ common     │   ▾ 📁 skills/                        │ │
│ └────────────┴───────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- 左栏：模板列表。点击切换右栏树。右键：重命名模板 / 删除模板（二次确认）/ 在访达中打开。
- 右栏：选中模板的文件树。节点右键：在外部编辑器打开 / 新建文件 / 新建文件夹 / 挂载到… / 重命名 / 删除。
- 工具栏：手动刷新（窗口 focus 时也自动刷新）、在访达打开模板库、"新建模板"（输入名称，在模板库根下 mkdir）。
- 名称校验（模板与节点通用）：非空、不允许路径分隔符与 `.`/`..`、同级重名拒绝（提示原因，不静默改写）。
- 空状态：模板库为空时右栏显示引导（[新建模板] + [在访达中打开模板库]）。
- 树的实现优先复用 `@collab/components/TreeView`；若接口适配成本高则做简化版树（实现时评估）。

### 5.2 模板库初始化

`<COLLAB_DIR>/templates` 不存在时，打开模板窗口自动 `mkdir -p`（空模板库 + 空状态引导）。不做旧目录迁移。

## 6. 拖拽挂载设计

### 6.1 拖拽协议（drag-session）

1. 模板窗口节点 `dragstart` → RPC `templateDrag.start`，携带 `{ template, relPath, name, isDir }`；主进程登记载荷，并 `forwardToWebview("nav", "template-drag:start", payload)`。
2. nav 收到后进入"接收状态"；`dragover` 合法节点 → 高亮 + tooltip「在 src/ 下创建软链接：rules → VUE-SHADCN/rules」；非法节点 → 禁止光标 + 原因提示。
3. `drop` → RPC `templateDrag.drop`，携带目标 `{ workspace, relPath }`。主进程执行 `link.check` 冲突预检 → 弹原生确认框 → 按用户选择执行 `link.create`（或替换 / 换名 / 取消）。
4. `dragend` → RPC `templateDrag.end` 清理登记态。

### 6.2 放置目标规则

| 悬停对象 | 行为 |
| --- | --- |
| workspace 根节点 | 可放置，建到 workspace 根下 |
| 普通目录节点 | 可放置，建到该目录内 |
| 文件节点 | 禁止（禁止光标 + 灰字原因） |
| 挂载节点（软链接）内部 | 一律禁止——防止把链接建进模板库内部污染模板源 |
| 树空白区域 | 禁止（不做隐式吸附） |

### 6.3 确认框（原生 dialog）四态

| 状态 | 触发条件 | 内容 | 按钮 |
| --- | --- | --- | --- |
| 正常 | 目标无同名条目 | 「在 workspace-a / src 创建软链接」+ detail 显示 `rules → VUE-SHADCN/rules` | [取消] [创建]，附「以后不再询问」checkbox |
| 同源已存在 | 同名条目是指向同一源的软链接 | 「已挂载，无需操作」 | [好] |
| 冲突·软链接 | 同名条目是软链接（不同源） | 显示现指向（如 `→ common/rules`）与将替换为的源 | [取消] [重命名] [替换] |
| 冲突·真实内容 | 同名条目是真实文件/目录 | 说明为避免误删用户数据仅支持换名 | [取消] [以 `<name>-1` 创建]（自动计算不冲突名） |

- 勾选「以后不再询问」后（存 pref，如 `ui.skipTemplateMountConfirm`），后续"正常"态直接建链，nav 树刷新并在新链接节点上做一次短暂高亮作为反馈。
- 冲突态永远询问（不适用跳过）。

### 6.4 右键「挂载到…」（兜底入口，必须实现）

模板窗口任意节点右键 → 「挂载到…」→ 窗口内弹层选择目标：workspace 及其子目录树（懒加载），选择后走同一 `link.check` + 确认框 + `link.create` 流程。理由：跨窗口拖拽可能受窗口遮挡 / 平台差异影响，此入口不依赖拖拽即可完成挂载。

## 7. nav 侧扩展

### 7.1 挂载节点呈现

- 节点前缀 🔗，来源模板名以弱化后缀显示（如 `rules` + `VUE-SHADCN`）；悬停 tooltip 显示完整目标路径。
- 节点可正常展开（显示模板内容）；**其内部节点不可作为放置目标**（见 6.2）。
- 断链（悬空软链接）：显示 ⚠ 标识，不崩溃；右键仍可移除。

### 7.2 右键菜单

| 项 | 条件 | 行为 |
| --- | --- | --- |
| 在外部编辑器打开 | 挂载节点 | 复用 external-editor |
| 在访达中显示 | 挂载节点 | `shell.showItemInFolder` |
| 在模板库中显示来源 | 挂载节点 | 打开模板窗口、选中对应模板、定位到树中节点 |
| 移除链接… | 仅软链接 | 确认「从 workspace 移除链接，不影响模板库内容」→ `link.remove` |

### 7.3 入口

nav 侧边栏顶部按钮「🧩 模板」（与 [文件] [磁贴] [待办] 同排）→ IPC → 主进程 `showTemplatesWindow()`：未创建则创建，已存在则 focus。

## 8. RPC 接口一览（templates-rpc）

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `templates.list` | — | `string[]` | 模板名列表（忽略 dot 开头项） |
| `templates.tree` | `{ template, relPath? }` | 节点数组 | 懒加载子节点（含 `isSymlink`） |
| `templates.create` | `{ name }` | 新列表 | 新建模板目录 |
| `templates.rename` | `{ name, newName }` | 新列表 | 重命名模板 |
| `templates.delete` | `{ name }` | 新列表 | 删除模板（UI 侧二次确认） |
| `templates.createNode` | `{ template, relPath, kind, name }` | 节点 | 新建文件 / 文件夹 |
| `templates.renameNode` | `{ template, relPath, newName }` | 节点 | 重命名节点 |
| `templates.deleteNode` | `{ template, relPath }` | — | 删除节点 |
| `templates.openExternal` | `{ template, relPath?, isDir }` | — | 外部编辑器打开 |
| `templates.reveal` | `{ template, relPath? }` | — | 在访达中显示 |
| `link.check` | `{ source, target }` | `{ status, existing? , suggestedName? }` | 冲突预检 |
| `link.create` | `{ source, target, name?, replace? }` | `{ path }` | 建链（唯一写口，重复校验） |
| `link.remove` | `{ workspace, relPath }` | — | 卸载（校验必须是软链接） |
| `templateDrag.start` / `.drop` / `.end` | 见 6.1 | — | drag-session 协调 |

所有涉及路径的方法在主进程做 Realpath 校验：源必须在 `TEMPLATES_DIR` 内，目标必须在对应 workspace 根内，拒绝路径穿越。

## 9. 错误处理与边界

- 建链失败（权限 / 目标不可写）：错误 toast/对话框提示，UI 状态不变。
- 模板目录被外部删除：nav 中对应软链接成为断链，按 7.1 显示 ⚠，可移除。
- 删除模板：原生确认对话框（提示将删除整个目录，不可恢复）。
- Windows：创建软链接可能需要开发者模式 / 管理员权限；失败时给出明确错误说明（主支持平台为 macOS）。
- 外部编辑器未配置：沿用现有 system-app 兜底，不新增分支。

## 10. 测试策略

- **单元测试**（`bun test`，主进程侧，参考 `claude-md.test.ts` 模式）：
  - `link.check` 冲突矩阵：目标不存在 / 同源软链 / 异源软链 / 真实文件 / 真实目录 / 断链
  - 路径安全：越出模板库根、越出 workspace 根的 input 一律拒绝
  - `link.create` / `link.remove` 的 fs 行为（临时目录 fixture）
  - `templates.*` 的 fs 行为（创建 / 重命名 / 删除 / 冲突名）
- **技术验证 spike（实现第一步）**：跨窗口 HTML5 DnD 事件（dragstart → dragover → drop）在 macOS 打包/开发环境下的可靠性；不通过则以右键「挂载到…」为主入口并上报调整。
- **手动测试清单**：拖拽全流程（合法/非法目标）、确认框四态、「以后不再询问」、右键挂载、卸载、断链显示、入口按钮与窗口生命周期（创建/聚焦/销毁/尺寸记忆）、空状态、外部编辑器未配置兜底、窗口排布场景（模板窗口遮挡 nav 时拖拽是否可用，不可用则引导右键挂载）。

## 11. 未来扩展（本次明确不做）

- 硬链接选项、多模板库根、模板参数化、模板预览、反向"保存为模板"。
