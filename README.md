# dt：给 Agent 用的动态表格

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/python-3.11%2B-blue)

dt 是一个本机运行的动态表格。Agent 通过 Skill 学会用法，用 `dt` CLI 建表、读写数据；人在浏览器里实时查看和编辑同一份数据，并能看到每次修改是哪个 agent 做的。

- **声明式表结构**：用 YAML 模版定义表和多级子表，`dt table apply` 对比现状生成变更计划，破坏性变更需要 `--force`。
- **为 agent 设计的 CLI**：所有输出都是 JSON，错误带 `hint`；按「域 → 表 → 字段」三层渐进获取结构，不用预先知道表定义。
- **实时页面**：表格视图、记录抽屉、附件预览，CLI 改数据后页面 1 秒内高亮变更并标出操作者。
- **事件绑定**：记录变化时触发 webhook、本机命令、写回记录或收件箱消息，at-least-once 投递并自动重试。
- **知识图谱**：记录是节点，父子关系和 link 字段是边，实时显示哪个 agent 改了什么，可按表、焦点、操作者、时间筛选。

完整设计见 [docs/design.md](docs/design.md)。

## 安装

需要 Python 3.11+、[uv](https://docs.astral.sh/uv/) 和 Node.js 20.19+（构建页面用）。

```bash
git clone https://github.com/OWNER/REPO.git && cd REPO
(cd web && npm ci && npm run build)   # 页面构建到 src/dt/static
uv tool install .                     # 安装 dt 命令
```

只想在仓库里试用，不安装：`uv sync` 之后用 `uv run dt ...`。

## 快速开始

```bash
dt serve                              # 启动服务，打开 http://127.0.0.1:8654
```

CLI 发现服务没启动时会自动在后台拉起它，所以通常不需要手动运行这一步。

```bash
cat > task.yaml <<'YAML'
name: task
label: 任务
description: 要做的事
fields:
  - {key: title, label: 标题, type: text, required: true}
  - {key: status, type: single_select, options: [待办, 进行中, 完成], default: 待办}
children:
  - name: task_log
    label: 任务日志
    fields:
      - {key: content, type: long_text, required: true}
YAML

dt domain create demo -A me --label 示例
dt table apply -D demo -A me -f task.yaml
dt rec insert task -D demo -A me --data '{"title":"写设计","task_log":[{"content":"开始"}]}'
dt rec query task -D demo --where '{"status":"待办"}' --include task_log
dt rec update task 1 -D demo -A me --set '{"status":"完成"}'
```

- `-D <域>`：域内命令必须显式写，dt 不从环境变量读域。
- `-A <操作者>`：写入命令必须写（也可以用环境变量 `DT_ACTOR`），页面和变更历史靠它区分是谁改的。

## 给 agent 用

把 `skills/` 下的目录复制到 agent 的 skill 目录，例如 Claude Code：

```bash
cp -r skills/* ~/.claude/skills/
```

| Skill | 用途 |
|---|---|
| `dt-schema` | 设计和修改表模版 |
| `dt-data` | 增删改查数据、挂附件 |
| `dt-event-bind` | 创建和管理事件绑定 |
| `dt-event-consume` | 消费事件流、读收件箱 |

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DT_HOME` | `~/.dt` | 数据库、日志所在目录 |
| `DT_PORT` | `8654` | 服务端口 |
| `DT_ACTOR` | 无 | 写入时的操作者，`-A` 的后备值 |

服务只监听 `127.0.0.1`，没有登录鉴权，面向本机单人使用。安全边界见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
uv sync                               # 安装 Python 依赖
uv run pytest                         # 跑测试
uv run dt serve                       # 启动后端
cd web && npm ci && npm run dev       # 前端开发服务器，/api 代理到 8654
cd web && npm run typecheck           # 前端类型检查
```

目录结构：

```
src/dt/     服务端与 CLI（FastAPI、Typer、SQLite）
web/        React 前端（Vite、Tailwind、TanStack Table）
skills/     给 agent 的 Skill
tests/      pytest
docs/       设计文档
```

欢迎贡献，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
