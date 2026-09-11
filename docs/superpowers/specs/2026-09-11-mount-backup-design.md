# 挂载备份机制（自动历史 / 命名备份 / 差异恢复）· 设计

日期：2026-09-11
状态：待评审
关联：《2026-09-10 模板管理功能 · 设计》

## 1. 背景与目标

模板挂载（见关联文档）目前是**无记录**的：挂载状态完全由扫描 workspace 内的软链接得出，应用不保存任何历史。2026-09-11 发生了一次误操作——在「移除链接」确认框（默认按钮为 Remove）上误触回车，取消了一条关联；由于没有任何记录，事后只能靠目录时间戳人工推断现场。

目标：为挂载体系增加"自动历史 + 命名备份 + 按卡点恢复"的能力：

- 能够新建备份（给当前挂载状态命名存档）
- 能够查询备份 / 历史列表，并按任意历史点恢复挂载
- 恢复 = 差异应用：以目标状态点为准，补建缺失、移除多余、修正指向；恢复前给出缺失 / 多余汇总
- 记录与恢复不引入第二事实源：文件系统仍是唯一真值，历史只是一份带时间戳的观察

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 状态点（HistoryPoint） | 一次挂载 / 取消 / 恢复之后的全量挂载快照（操作描述 + 清单） |
| 命名备份 | 用户手动命名（如"改版前"）的状态点，永久保留 |
| 差异恢复 | 恢复实现：对比当前磁盘与目标状态点，仅应用差异 |
| 挂载清单（MountRecord） | 某时刻所有 workspace 内指向模板库的软链接集合 |

## 3. 范围

### In scope

- 自动历史：drop-mount / mount-to / remove-link 成功后的状态点自动记录
- 命名备份：新建 / 重命名 / 删除；空历史时的基线记录
- 外部变更检测：磁盘与最新记录不一致时的提示与补记
- 差异恢复：预览（缺失 / 多余 / 指向不对 / 跳过）+ 应用 + 结果摘要 + 恢复点追加
- 模板窗口工具栏「历史 / 备份」入口与弹面板
- 移除确认框默认按钮改为 Cancel（降低误触）

### Out of scope（明确不做）

- 模板内容本身的版本 / 备份（仅备份挂载关系）
- 非模板库软链的跟踪与恢复
- 远程模式下 Client 端的备份操作（历史随 Host 主进程）
- 定时自动备份、历史导出 / 导入

## 4. 数据模型与存储

```ts
interface HistoryPoint {
  id: string;              // 时间戳派生，唯一
  ts: number;              // 记录时间（epoch ms）
  kind: "auto" | "named" | "restore";
  label?: string;          // 命名备份名称（kind=named 时必有）
  op: string;              // 操作描述，如 "挂载 VUE-SHADCN/skills → 篡改猴"
  mounts: MountRecord[];   // 快照：该时刻全量挂载清单
}

interface MountRecord {
  workspace: string;
  linkRel: string;         // 链接在 workspace 内的相对路径
  template: string;        // 来源模板名
  sourceRel: string;       // 模板内相对路径（"" = 模板根整体挂载）
  broken: boolean;
}
```

- **生成方式**：复用既有 `scanWorkspaceMounts` 全 workspace 扫描，不新增事实源
- **存储**：`<COLLAB_DIR>/mount-history.json` 单文件 `{ version: 1, points: [] }`，原子写（复用 `atomicWriteFileSync`）；dev 模式随 COLLAB_DIR 隔离
- **保留策略**：auto 点上限 500 条（自最旧淘汰），named / restore 点永久保留

## 5. 记录机制

### 5.1 触发点（主进程 IPC 成功路径）

| 时机 | kind | op 示例 |
| --- | --- | --- |
| 拖拽挂载成功（created / replaced / renamed） | auto | 挂载 VUE-SHADCN/skills → 篡改猴 |
| 「挂载到…」成功 | auto | 挂载 VUE-SHADCN/rules → frontend-manager |
| 「移除链接」成功 | auto | 取消 篡改猴/.claude/scripts-template |
| 差异恢复应用完成 | restore | 恢复至「改版前」（14:30） |

失败、用户取消路径不记录。所有 UI 挂载入口（模板窗口拖拽、nav 树拖拽、挂载到…对话框）均经由主进程统一入口，触发点只需挂在主进程即可全覆盖。

### 5.2 基线

历史为空时，面板提供「记录当前状态」按钮 → 走「新建备份」同一流程（输入名称，默认建议"基线"），存一个命名点。

### 5.3 外部变更检测

打开面板时对比磁盘扫描与最新状态点；不一致则显示提示行「检测到外部变更（N 处）」+ 「补记状态点」（kind: auto，op: "外部变更"）。不自动记录。

## 6. 恢复机制（差异恢复）

### 6.1 预览（dry-run）

对比组 = 当前磁盘全量扫描 vs 目标点 `mounts`。分类：

| 分类 | 判定 | 恢复动作 |
| --- | --- | --- |
| 缺失 | 记录有、当前无 | 创建软链 |
| 多余 | 当前有、记录无 | 移除（仅软链） |
| 指向不对 | (workspace, linkRel) 相同但 (template, sourceRel) 不同 | 移除后重建 |
| 跳过 | 见 6.3 | 报告，不动作 |

对比仅针对指向模板库的挂载软链；workspace 内其他文件、模板库内容、用户自有软链不参与、不入列。

### 6.2 应用

1. 先执行移除 / 替换（unlink），再执行创建（symlink），避免同名冲突
2. 全部路径经 safeJoin 校验（限定 workspace 内 / 模板库内）
3. 完成后重扫校验 → 结果摘要：成功 X / 失败 Y / 跳过 Z，附断链警告
4. 追加 restore 状态点（op 为"恢复至 <目标点名>（<时间>）"）
5. 幂等：中断或部分失败后再次恢复，重新计算差异并继续
6. 范围：全局（所有 workspace 一起对比与应用），不提供单 workspace 恢复

### 6.3 安全约束与边界

硬约束：

- **只动软链**：目标位置是真实文件 / 目录 → 跳过并报告，永不删除或覆盖
- 移除前验证确实是软链（复用 `removeLinkAt` 的既有保护）
- 不触碰模板库内容

| 情况 | 行为 |
| --- | --- |
| 记录中的 workspace 已不存在 | 该 workspace 条目全部跳过并报告 |
| 目标位置是真实文件 / 目录 | 跳过，报告"需人工处理" |
| 模板源缺失（template / sourceRel 不存在） | 记"源缺失"，跳过 |
| 当前多余项是用户自有软链（非模板库） | 不动，不入列 |
| 目标点条目为断链 | 尝试重建；源缺失则跳过 + 报告；恢复后校验阶段报告残留断链 |
| 与当前状态完全一致 | 提示"已一致，无需恢复" |

## 7. UI 设计

### 7.1 入口

模板窗口工具栏新增「历史 / 备份」按钮 → 弹出面板（沿用「挂载到…」弹层风格）。

### 7.2 面板结构

```text
┌─ 挂载历史 / 备份 ──────────────── [新建备份] ┐
│ ⚠ 检测到外部变更（2 处）          [补记状态点] │  ← 条件显示
│ ★ 改版前                       14:30        │
│ ○ 取消 篡改猴/.claude/scripts…  14:28        │
│ ○ 挂载 VUE-SHADCN/skills → …   14:01        │
│ ┌ 选中点详情 ─────────────────────────────┐ │
│ │ 挂载清单（21 条）                        │ │
│ │   VUE-SHADCN/rules → frontend-analysis   │ │
│ │   …                                      │ │
│ │                        [恢复到此处]       │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

- 列表新→旧；命名点显示 ★ + 名称（可重命名 / 删除）；auto / restore 点只读
- 选中点 → 详情（挂载清单）→ [恢复到此处] → 预览视图（四组清单）→ [确认恢复]
- 恢复完成 → 就地结果摘要（成功 / 失败 / 跳过）
- 面板打开期间收到 `templates:history-changed` → 实时刷新

### 7.3 i18n

`src/windows/templates/src/i18n.ts` 新增 zh / en 键（如 `history.panelTitle` / `history.newBackup` / `history.restore` / `history.preview.missing` 等）。

## 8. 实现要点

### 8.1 主进程

新增 `src/main/mount-history.ts`：load / save / append（含淘汰）、createNamedBackup、renamePoint、deletePoint、previewRestore、applyRestore；复用 templates.ts 的 `scanWorkspaceMounts`、`createLink`、`removeLinkAt`、`TEMPLATES_DIR`（按需导出或经 ctx 注入）。

`src/main/templates.ts` 新增 bindIpc：

| 通道 | 说明 |
| --- | --- |
| `templates:history-list` | 全量列表 |
| `templates:history-create-backup` | `{ label }` 扫描当前状态存命名点 |
| `templates:history-rename` | `{ id, label }` 仅命名点 |
| `templates:history-delete` | `{ id }` 仅命名点 |
| `templates:history-preview-restore` | `{ id }` 返回四分类差异 |
| `templates:history-apply-restore` | `{ id }` 执行并返回结果摘要 |

另：三种挂载操作成功路径调用追加记录；新增 `forwardToTemplates("templates:history-changed")`。

### 8.2 模板窗口 renderer

`App.tsx` 工具栏按钮 + 新组件 `HistoryPanel.tsx`（列表 → 详情 → 预览 → 结果 状态机）；桥接按现有 `window.api.templates*` 模式在 preload / 桥接层新增。

### 8.3 附带改动

`templates:remove-link` 确认框默认按钮由 Remove 改为 Cancel（`defaultId: 1` → `0`，文案不变）。

## 9. 测试

`src/main/mount-history.test.ts`（bun test，参考 templates.test.ts 的 fs fixture 模式）：

- append 与 500 条淘汰（named / restore 永不淘汰）
- createNamedBackup / renamePoint / deletePoint
- previewRestore 四分类：缺失 / 多余 / 指向不对 / 跳过（真实文件、源缺失、workspace 缺失）
- applyRestore：先删后建、幂等（二次执行为"已一致"）、真实文件零触碰

手动测试清单：自动记录触发（拖拽 / 挂载到… / 移除）、外部变更提示与补记、空历史基线、命名 / 重命名 / 删除、预览四分类、恢复应用与结果摘要、恢复点可再恢复、面板实时刷新、移除确认框默认按钮。

## 10. 未来扩展（本次不做）

- 模板内容版本化 / 快照
- 单 workspace / 单条目的定向恢复
- 历史导出 / 导入、跨机同步（远程模式 Client 端）
