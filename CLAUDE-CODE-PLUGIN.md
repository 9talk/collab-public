# Collaborator Claude Code Plugin

Collaborator 提供了一个 Claude Code 插件，用于在 Collaborator 的终端 Tile 中运行的 Claude Code 会话中启用声音通知、会话集成和画布焦点控制。

## 安装方式

### 手动配置

在 Claude Code 的 `settings.json` 文件中添加以下内容：

```json
{
  "extraKnownMarketplaces": {
    "collaborator": {
      "source": {
        "source": "directory",
        "autoUpdate": true,
        "path": "/Applications/Collaborator.app/Contents/Resources/collab-claude-plugin"
      }
    }
  },
  "enabledPlugins": {
    "collaborator@collaborator": true
  }
}
```

Claude Code 的 `settings.json` 文件位置：
- **macOS**: `~/Library/Application Support/Claude/claude_code/settings.json`
- **Linux**: `~/.config/Claude/claude_code/settings.json`
- **Windows**: `%APPDATA%\Claude\claude_code\settings.json`

> 注：请确保 Collaborator 已安装到 `/Applications/Collaborator.app` 目录。

## 功能

- **声音通知**：在 Claude Code 的不同事件（提交提示、停止回复、权限请求等）发生时播放提示音
- **Tile 焦点控制**：在权限请求时自动聚焦到对应的 Tile
- **会话完成通知**：Claude Code 回复完成时发送通知

