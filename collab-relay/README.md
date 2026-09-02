# collab-relay — Collaborator 远程中继服务器

零知识 WebSocket 中继：被控端（Host）与控制端（Client）都出站连接本服务器，凭配对码绑定为一个会话，之后的指令/事件/PTY 数据原样透传，服务器不解密、不解析业务内容。

## 启动

```bash
# 最简单：单设备 token（测试用）
bun run src/index.ts --port 8787 --token test-device-token

# 多个 token 用逗号分隔
bun run src/index.ts --port 8787 --token tok1,tok2,tok3

# 持久化配对状态（默认 data/ 目录；--no-persist 关闭）
bun run src/index.ts --port 8787 --token tok1 --persist-dir /var/lib/collab-relay

# TLS（wss://）
bun run src/index.ts --port 443 --token tok1 --tls-key key.pem --tls-cert cert.pem

# 环境变量方式（与 CLI 等价）
RELAY_DEVICE_TOKENS=tok1,tok2 bun run src/index.ts --port 8787
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | 8787 | 监听端口 |
| `--token` / `--tokens` | 无 | 预配的设备 token（逗号分隔），Host 认证用 |
| `--persist-dir` | `data` | 配对码持久化目录（`codes.json`），relay 重启后恢复 |
| `--no-persist` | - | 关闭持久化 |
| `--tls-key` / `--tls-cert` | 无 | 启用 wss（两个都要给） |
| `--max-clients` | 1 | 每个 Host 同时允许的 Client 数 |

## 认证与配对

1. **Host（被控端）**：携带 `deviceToken` 认证 → 调 `pair-create` 获得 6 位配对码（TTL 10 分钟）。
2. **Client（控制端）**：携带配对码认证。relay 校验后把两条连接绑定为 room，双方收到 `peer-connected`。
3. 配对码在 TTL 内持续有效：Client/Host 断线重连、relay 重启恢复（`--persist-dir`）后可用同码重新配对；连续 5 次错误尝试会锁定该码。

## 协议

详见 `src/protocol.ts`。要点：

- **文本帧**（JSON，均含 `v:1`）：`auth` / `auth-ok` / `auth-error` / `pair-create` / `pair-created` / `peer-connected` / `peer-disconnected` / `rpc` / `rpc-result` / `rpc-error` / `event`
- **二进制帧**（仅 PTY 数据，A→B）：`[1B sessionId 长度][sessionId][payload]`
- 心跳：relay 每 30s `ping`，60s 无 `pong` 判定死连接
- relay 对 `rpc`/`rpc-result`/`rpc-error`/`event`/二进制帧**原样透传**（零知识）

## 安全模型

- 信任全部收敛在**配对码**上：持有配对码即获得访问权，请在安全渠道（当面/电话）分发。
- 生产建议：relay 上 `--tls-key/--tls-cert` 启用 wss；限流由反向代理（nginx/caddy）承担。
- relay 无业务解密能力；如需内容级防护，请在 Host/Client 端做端到端加密（v2 规划）。
