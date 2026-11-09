# 贡献指南

感谢你愿意改进 dt。提 issue 或 PR 前请先读完这页。

## 开发环境

```bash
uv sync                          # Python 依赖（含 pytest）
(cd web && npm ci)               # 前端依赖
uv run dt serve --port 8655      # 后端；用 DT_HOME=/tmp/dt-dev 隔离开发数据
(cd web && DT_PORT=8655 npm run dev)
```

开发时建议设置 `DT_HOME` 指向临时目录，避免改动自己日常用的 `~/.dt`。

## 提交前检查

```bash
uv run pytest                    # 后端测试
(cd web && npm run typecheck)    # 前端类型检查
(cd web && npm run build)        # 确认能构建
```

CI 会跑同样的检查，全部通过才能合并。

## 约定

- **先改设计再改代码**：涉及 CLI、HTTP API、数据模型或页面行为的变更，同步更新 [docs/design.md](docs/design.md)。
- **CLI 输出给 agent 看**：保持 `{"ok", "data"}` / `{"ok", "error": {code, message, hint}}` 格式；新错误要给出能让 agent 自行修正的 `hint`。
- **改了 CLI 用法要更新 Skill**：`skills/*/SKILL.md` 和 `references/` 是 agent 的唯一说明书。
- **测试**：后端行为变更需要在 `tests/` 下补 pytest；用例走 HTTP 接口（见 `tests/conftest.py` 的 `api` fixture）。
- **风格**：跟随周围代码。注释、错误信息、文档用中文；标识符用英文。
- **范围**：一个 PR 只做一件事，不夹带无关重构。

## 提交信息

一句话说明改了什么，必要时在正文里写原因。例如：

```
图谱：焦点模式只沿当前显示的边遍历

之前隐藏的 link 边也参与 BFS，导致焦点范围比看到的大。
```

## 报告问题

- Bug：用 Bug 模版，附上 `dt` 命令、完整 JSON 输出和 `$DT_HOME/server.log` 里的相关日志。
- 安全问题：不要公开提 issue，按 [SECURITY.md](SECURITY.md) 处理。
