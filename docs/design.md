# dt：给 Agent 用的动态表格

Agent 通过 Skill 学会用法，通过 `dt` CLI 操作数据；人在浏览器里实时查看和编辑。

## 1. 范围与约束

- 本机单人使用：SQLite，服务只监听 `127.0.0.1`，没有登录鉴权。
- 域：一组表的命名空间（例如一个项目一个域）。表名在域内唯一，不同域可以有同名表，数据隔离；link 不能跨域。CLI 操作表和数据时必须指定域。
- 模版即表：一个模版定义一张表，以及它的子表树；域模版定义一个域里的所有表。
- 子表是父子嵌套，层数不限，例如 任务 → 任务日志 → 日志附件。
- 页面可编辑，人和 agent 协同修改同一份数据。

## 2. 架构

```
Agent ──(Skill)──> dt CLI ──HTTP──┐
                                  ├──> FastAPI 服务 ──> SQLite (WAL)
浏览器 ──HTTP 编辑 / WebSocket────┘        │
                                         └── 每次写入记 dt_changes，并推送给页面
```

- 所有写入只走服务端。CLI 不直连数据库，这样每次修改都经过同一套校验、审计和推送。
- CLI 发现服务没启动时自动拉起 `dt serve`，日志写到 `$DT_HOME/server.log`。
- 环境变量：`DT_HOME`（默认 `~/.dt`）、`DT_PORT`（默认 `8654`）、`DT_ACTOR`（操作者，`-A` 的后备值）。域不读环境变量，见第 8 节。
- 技术栈：Python 3.11+（FastAPI、Typer、SQLite），前端用 React（Vite、TanStack Table、shadcn/ui、Tailwind）。

## 3. 数据模型

记录的字段值统一存在 `dt_records.data`（JSON）里，不给每张表建物理表。增删字段不需要迁移，查询用 `json_extract` / `json_each`。

| 表 | 关键列 |
|---|---|
| `dt_domains` | name, label, description |
| `dt_tables` | domain_id, name（域内唯一）, label, parent_id, relation（`one_to_many` / `one_to_one`）, on_delete（`cascade` / `restrict`）, schema_version |
| `dt_fields` | table_id, key, label, type, required, uniq, default_value, options, config, position, archived |
| `dt_records` | table_id, parent_id, data, version, created_by, updated_by, created_at, updated_at |
| `dt_changes` | seq, tx, domain, table_name, record_id, op, before, after, fields, actor, ts |
| `dt_change_fields` | seq, field（记录事件实际变化的字段，按字段筛选走索引） |
| `dt_counters` | table_id, field_key, value（auto_number 计数器） |
| `dt_bindings` | domain, name, ops, table_name, field, where_expr, where_before, prompt, action, config, enabled |
| `dt_deliveries` | binding_id, change_seq, last_seq, seqs, event_count, status, attempts, next_attempt_at, last_error, last_result |
| `dt_inbox` | domain, binding_id, binding_name, event_seq, table_name, record_id, op, title, body, prompt, events, status, created_at, read_at |

### 系统字段

每条记录都带下面这些只读系统字段，以下划线开头，不会和用户字段冲突：
`_id`、`_parent_id`、`_version`、`_created_at`、`_updated_at`、`_created_by`、`_updated_by`。

`_id` 在所有表之间全局唯一（都来自 `dt_records.id`），但只能通过它所在的域访问。需要每张表从 1 开始的编号时，用 `auto_number` 字段。

### 旧库迁移

打开没有域的旧库时，先在同目录备份成 `dt.db.bak-<时间>`，再把已有的表全部放进 `default` 域，记录和 `_id` 不变。

### 命名规则

域名、表名和字段 key 都要匹配 `^[a-z][a-z0-9_]{0,62}$`。域名全局唯一，表名在域内唯一。子表名不能和父表的字段 key 重名，因为嵌套插入和 `--include` 输出时，子表数据就放在这个 key 下。

## 4. 字段类型

| type | 写入值 | 说明 |
|---|---|---|
| `text` / `long_text` | 字符串 | |
| `number` | 数字，或可以解析成数字的字符串 | |
| `date` | `YYYY-MM-DD` | |
| `datetime` | ISO 8601 | 存储前统一格式 |
| `checkbox` | `true` / `false` | |
| `single_select` | 选项值 | 选项定义 `options: [{value, color}]`，也可以简写成字符串列表 |
| `multi_select` | 选项值数组；传单个字符串时自动包成数组 | |
| `url` | `http(s)://...` | |
| `email` | 邮箱 | |
| `person` | 字符串（人名或 agent 名） | |
| `auto_number` | 只读 | 插入时自动分配，每张表单调递增 |
| `link` | 记录 id，或 id 数组 | `config: {table, multiple}`，引用非父子关系的其他表 |
| `attachment` | 绝对路径，或路径数组 | 见第 5 节 |

通用属性：`label`、`required`、`unique`、`default`、`description`。

v1 不做公式和汇总字段。

## 5. 附件字段

agent 产出物通常就是一个绝对路径，所以附件字段只**引用**路径（ref 模式），不复制文件。路径可以是文件，也可以是目录。

```yaml
- key: output
  type: attachment
  config:
    multiple: true            # 默认 false
    accept: [.md, .png, .pdf] # 可选，只约束文件，不约束目录
```

- 写入时校验：必须是绝对路径、路径必须存在、文件扩展名符合 `accept`。
- 服务端补齐元数据后存储：
  ```json
  {"path": "/abs/report.md", "name": "report.md", "kind": "file", "size": 20480,
   "mime": "text/markdown", "sha256": "…", "mtime": "…", "added_at": "…", "added_by": "claude"}
  ```
  目录的 `kind` 是 `dir`，记录 `file_count` 和总 `size`，不计算 sha256。
- 已有附件再次写入时，保留原来的 `added_at` 和 `added_by`。
- 页面检测到原文件丢失时显示「文件已丢失」；sha256 不一致时显示「文件已变更」。
- 文件读取接口只返回附件字段里登记过的路径，不接受任意路径参数。

## 6. 模版 DSL

```yaml
name: task
label: 任务
fields:
  - {key: title, label: 标题, type: text, required: true}
  - key: status
    type: single_select
    options: [{value: 待办, color: gray}, {value: 进行中, color: blue}, {value: 完成, color: green}]
    default: 待办
  - {key: due, label: 截止, type: date}
  - {key: output, label: 产出物, type: attachment, config: {multiple: true}}
children:
  - name: task_log
    label: 任务日志
    relation: one_to_many      # 默认 one_to_many
    on_delete: cascade         # 默认 cascade
    fields:
      - {key: content, type: long_text, required: true}
      - {key: level, type: single_select, options: [info, warn, error]}
  - name: task_board
    relation: one_to_one
    fields:
      - {key: column, type: single_select, options: [Backlog, Doing, Review, Done]}
```

`dt table apply` 是声明式的：把 spec 和数据库现状做对比，生成变更计划。

| 变更 | 是否破坏性 |
|---|---|
| 新建表、新增字段、改 label / description / default / required / unique、新增选项、改选项颜色 | 否 |
| 删除字段（spec 里没有了，字段会被标记为 archived，数据保留） | 是 |
| 删除选项、修改字段类型 | 是 |
| 改 relation / on_delete | 是 |
| 修改已有表的父表 | 不允许 |
| 已有子表从 spec 里消失 | 不处理，只在计划中提示，需要用 `dt table drop` 删除 |

破坏性变更必须加 `--force`。`--dry-run` 只输出计划，不执行。spec 里出现之前 archived 的字段时，该字段会被恢复。

### 域模版

```yaml
name: proj_a
label: 项目 A
tables: [<表模版>, <表模版>]   # 顶层表，子表写在各自的 children 里，不能写 parent
```

`dt domain apply` 也是声明式的：域不存在时先建域，然后按上表的规则逐张 apply；模版里没有的已有顶层表只在计划中提示 `keep_table`，不删除。

## 7. 查询 DSL

```json
{"status": {"in": ["待办", "进行中"]}, "due": {"lt": "2026-11-10"}, "title": {"contains": "设计"},
 "$or": [{"priority": "高"}, {"_created_by": "claude"}]}
```

- 直接写值等价于 `eq`。
- 运算符：`eq ne gt gte lt lte in nin contains is_null`。
- `contains` 用在文本字段上是子串匹配；用在 multi_select、link、attachment 上是数组包含（attachment 匹配 path）。
- 可以用 `$and` 和 `$or` 组合条件；系统字段也能参与筛选。
- `sort`：`"-_updated_at,title"`，前缀 `-` 表示降序。
- `include`：`"task_log,task_log.log_attachment,task_board"`，按点号路径带出子表数据。

## 8. CLI

所有命令默认输出 JSON：`{"ok": true, "domain": "...", "data": ...}`，或 `{"ok": false, "error": {"code", "message", "hint"}}`。出错时退出码为 1。域内命令的返回带 `domain`，方便 agent 核对。

- **域必须显式写 `-D`**，不读环境变量。agent 每次调用可能是新 shell，`export` 留不住；终端里残留的环境变量又会让数据静默写进别的域；命令里写明域也方便人审查。
- **写入必须表明操作者**：`-A <名字>`，或环境变量 `DT_ACTOR`。都没有时报 `actor_required`，不再默认记成 `cli`。dry-run 和只读命令不需要。

### 渐进式披露

agent 不预先知道表结构，按三层逐步获取，每层只拿当前需要的信息：

| 命令 | 返回 | 用途 |
|---|---|---|
| `dt domain list` | 每个域的 name、label、description、表数、记录数 | 选域 |
| `dt domain show <域>`（或 `dt table list -D <域>`） | 每张表的 name、label、description、记录数、子表树，**不含字段** | 按描述挑表 |
| `dt table show <表> -D <域>` | 字段的 key、type、label、description、required、default、options、config，子表概要 | 按字段描述读写数据 |

所以描述是给 agent 看的：域、表、字段都应该写 `description`。`dt table apply` 和 `dt domain apply` 的返回里有 `warnings`，列出缺描述的表和缺 label/description 的字段。

```bash
dt serve [--port 8654]
dt domain list | show proj_a | create proj_a [--label 项目A]
dt domain apply -f proj_a.yaml [--dry-run] [--force]
dt domain drop proj_a --force

# 以下命令都要写 -D <域>，写入命令还要写 -A <操作者>，示例里省略了
dt table apply -f task.yaml [--dry-run] [--force]
dt table list
dt table show task
dt table drop task --force                       # 连同子表和数据一起删除
dt field add task priority --type single_select --options 高,中,低

dt rec insert task --data '{"title":"写设计","task_log":[{"content":"开始"}]}'
dt rec insert task_log --parent 12 --data @log.json
cat rows.jsonl | dt rec insert task --batch      # 批量插入，单个事务
dt rec get task 12 --include task_log
dt rec query task --where '{...}' --sort -_updated_at --limit 20 --include task_log [--format table]
dt rec update task 12 --set '{"status":"完成"}' [--if-version 3]
dt rec attach task 12 output /abs/path [/abs/path2]   # 追加附件
dt rec impact task 12                           # 删除前预览：cascade、unlink、blocked
dt rec delete task 12
dt history [--table task] [--id 12] [--since SEQ]

dt graph related 12 [13 ...] [--by codex] [--depth 1|all] [--direction both|out|in] [--kinds parent,link:task.needs] [--tables a,b] [--limit 500]
                 [--where '{...}'] [--since SEQ] [--fields '*'|a,b] [--format json|table|mermaid|dot]
dt graph path 12 7 [--direction ...] [--kinds ...] [--format json|mermaid|dot]
dt graph lint [--tables a,b] [--limit 200]
dt graph ready --field task.needs --done '{"status":"完成"}' [--where '{...}'] [--fields ...] [--format table]
dt graph order [12 ...] --field task.needs [--done '{...}'] [--format table]
dt graph hubs [--tables a,b] [--kinds ...] [--limit 20] [--format table]

# 记录事件（只包含 insert / update / delete，带字段级 diff）
dt event list -D proj_a [--table task] [--field status] [--op update] [--id 12] [--since SEQ]
dt event watch -D proj_a [--table task] [--field status] [--op update] [--since SEQ] [--timeout 60]

# 事件绑定
dt event bind -D proj_a notify-done --on update --table task --field status \
  --where '{"status":"完成"}' --action webhook --config '{"url":"http://127.0.0.1:9000/hook"}' \
  --prompt '任务 ${record.title} 已完成，请检查产出'
dt event binds -D proj_a
dt event update -D proj_a notify-done [--prompt '...'] [--enabled/--disabled]
dt event unbind -D proj_a notify-done
dt event deliveries -D proj_a notify-done [--status failed]
dt event retry -D proj_a notify-done

# 收件箱（action=inbox 的绑定写入的消息）
dt inbox list -D proj_a [--status unread|read] [--limit 50] [--offset 0]
dt inbox read -D proj_a 12
dt inbox unread -D proj_a 12
dt inbox read-all -D proj_a
dt inbox delete -D proj_a 12
```

- `--data` / `--set` / `--where` 都支持三种写法：直接写 JSON、`@文件`、`-`（从 stdin 读）。
- 嵌套插入：在 data 里用子表名作 key。one_to_many 子表传数组，one_to_one 子表传对象。
- `--if-version` 是乐观锁，版本不一致时返回 `version_conflict` 错误。

## 9. HTTP API

前缀 `/api`，操作者通过 `X-DT-Actor` 请求头传递。表、记录、变更接口都在域下面，下表里的 `/tables...` 和 `/changes` 实际路径是 `/api/d/{domain}/tables...`、`/api/d/{domain}/changes`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/domains` · `/domains/{domain}` | 域列表 / 域和其中所有表的概要（不含字段） |
| POST | `/domains` | `{name, label, description}` 新建空域 |
| POST | `/domains/apply` | `{spec, dry_run, force}` |
| DELETE | `/domains/{domain}?force=true` | |

域内接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | |
| GET | `/tables[?brief=true]` · `/tables/{name}` | 表列表（brief 时只给概要）/ 一张表的字段定义和子表概要 |
| POST | `/tables/apply` | `{spec, dry_run, force}` |
| DELETE | `/tables/{name}?force=true` | |
| POST | `/tables/{name}/fields` | 新增字段 |
| POST | `/tables/{name}/records` | `{data, parent_id}` 或 `{rows: [...]}` |
| GET | `/tables/{name}/records/{id}?include=` | |
| POST | `/tables/{name}/query` | `{where, sort, limit, offset, include, parent_id}` |
| PATCH | `/tables/{name}/records/{id}` | `{set, if_version}` |
| GET | `/tables/{name}/records/{id}/impact` | 删除前预览，见第 14 节 |
| DELETE | `/tables/{name}/records/{id}` | 返回 `deleted` 和 `unlinked`（被去掉引用的记录） |
| POST | `/tables/{name}/records/{id}/attach` | `{field, paths}` |
| GET | `/changes` | `?table=&record_id=&since=&limit=` |
| GET | `/events` | `?op=&table=&field=&record_id=&since=&limit=`；只含 insert/update/delete，返回 `{items, seq}`，`seq` 是游标 |
| GET | `/graph` | `?tables=&limit=&at=&format=`；知识图谱的节点和边，见第 14 节 |
| GET | `/graph/related` | `?ids=&actor=&depth=&direction=&kinds=&tables=&limit=&where=&since=&fields=&format=`；关联查询 |
| GET | `/graph/path` | `?source=&target=&direction=&kinds=&format=`；两条记录间最短路径 |
| GET | `/graph/lint` | `?tables=&limit=`；悬空引用、孤立记录、依赖环 |
| GET | `/graph/ready` | `?field=&done=&where=&limit=&fields=`；依赖都完成、可以开工的记录 |
| GET | `/graph/order` | `?field=&ids=&done=`；按依赖的拓扑序 |
| GET | `/graph/hubs` | `?tables=&kinds=&limit=`；连接最多的记录 |
| GET/POST | `/bindings` | 事件绑定列表 / 新建 |
| PATCH/DELETE | `/bindings/{name}` | 修改 / 删除绑定 |
| GET | `/bindings/{name}/deliveries` | `?status=&limit=` 投递记录 |
| GET | `/bindings/{name}/deliveries/{id}` | 一条投递的详情：状态、时间、结果和携带的完整事件 |
| POST | `/bindings/{name}/retry` | 重新排队失败的投递 |
| GET | `/inbox` | `?status=unread|read&limit=&offset=`；返回 `{items, total, unread}` |
| PATCH | `/inbox/{id}` | `{status: "read"|"unread"}` |
| POST | `/inbox/read-all` | 全部标为已读 |
| DELETE | `/inbox/{id}` | 删除消息 |
| WS | `/ws/events?domain=&since=SEQ&op=&table=&field=` | 过滤后的记录事件流，消息类型 `event` |
| WS | `/ws?domain=&since=SEQ` | 只推送该域的变更，以及所有域的建域、改域、删域事件。先发 `{type: hello, seq}`，之后每条变更发 `{type: change, change}`；带 `since` 时先补发漏掉的变更。只接受本机 Origin |
| POST | `/files/status` | `{record_ids}` → 每个附件的 `ok` / `missing` / `changed` |
| GET | `/files/{record_id}/{field}/{idx}/tree` | 目录附件的文件列表（最多 5000 个） |
| GET | `/files/{record_id}/{field}/{idx}[?sub=相对路径]` | 读取已登记附件；目录附件用 `sub` 访问目录内文件，不允许 `..` 或符号链接越出目录；响应带 `CSP: sandbox`，HTML/SVG 里的脚本不会以本站身份执行 |

## 10. Skill

| Skill | 职责 | SKILL.md 要点 |
|---|---|---|
| `dt-schema` | 设计和修改模版 | DSL 和字段类型速查；先 `table list` 避免重复建表；变更必须先 `--dry-run`；子表关系怎么选（one_to_many / one_to_one / link） |
| `dt-data` | 增删改查数据 | 操作前先 `table show` 拿字段和选项值；查询 DSL 示例；嵌套插入、批量插入、附件写法；按 `error.hint` 自行修正；删除前确认级联范围 |
| `dt-event-bind` | 创建/修改事件绑定 | 域/表/字段条件、where/where_before、webhook/command/write/inbox、批量投递、安全确认 |
| `dt-event-consume` | 消费事件流 | 游标续拉、JSONL/批处理、幂等与回环规避、失败重试、收件箱读取 |

完整语法放在各 skill 的 `references/` 目录下，SKILL.md 本身保持简短。

## 11. 页面（M3/M4）

- 布局：左侧是表的树形导航；中间是主视图；右侧是可收起的实时动态流。
- 表格视图：虚拟滚动、单元格直接编辑、选项显示为彩色标签、行可展开显示子表、记录抽屉里子表按 Tab 分页。
- 附件：单元格显示文件图标和文件名；可预览图片、Markdown、代码和文本、PDF；目录附件按树形展示，可逐个预览；显示「文件已丢失」「文件已变更」状态。
- 看板视图：按任意 single_select 字段分组，卡片可拖拽。
- 事件视图：侧边栏「事件」进入；事件流可按操作 / 表 / 字段筛选，展示字段级 before → after 和原始 JSON；可新建、编辑、启停、删除绑定，查看投递记录并重试失败投递。
- 收件箱：侧边栏「收件箱」进入，显示未读角标；支持全部 / 未读筛选、全部已读、展开事件详情、打开记录、删除消息。收件箱由 `action: inbox` 的绑定写入。
- 实时：收到 WebSocket 事件后局部更新对应行，变更的单元格高亮 2 秒并标出操作者；断线重连时按 `seq` 补拉漏掉的事件。
- 支持深色和浅色主题。

## 12. 目录与里程碑

```
src/dt/
  db.py          连接、建表
  errors.py      DtError（code, message, hint）
  schema.py      模版 spec 解析、apply 计划与执行
  fields.py      字段值校验与规范化（含附件）
  query.py       where / sort 编译成 SQL
  records.py     记录 CRUD、嵌套插入、级联、changes
  events.py      记录事件、绑定匹配、投递与动作
  inbox.py       收件箱消息查询、已读与删除
  graph.py       知识图谱的节点和边，关联查询、路径、检查、删除影响
  server.py      FastAPI 路由
  cli.py         Typer CLI
skills/          dt-schema/、dt-data/、dt-event-bind/、dt-event-consume/
web/             React 前端
tests/
```

1. **M1** 元数据、记录 CRUD、校验、级联、附件、changes、HTTP API、CLI。验证：pytest 覆盖 apply 计划、嵌套插入、级联删除、选项校验、附件校验、查询 DSL、乐观锁，并通过 CLI 端到端跑一遍。
2. **M2** 两个 Skill。验证：agent 只靠 skill 从零建出 任务 / 日志 / 看板 三张表并完成增删改查。
3. **M3** 页面：表格视图、实时推送、附件预览。验证：CLI 改数据后页面 1 秒内高亮变更。
4. **M4** 看板视图、历史与撤销、深色主题。

## 13. 记录事件与绑定

只订阅**记录变化**（insert / update / delete），表结构变更不算事件。事件直接复用 `dt_changes`，不额外存事件表：`seq` 是游标，字段级差异在写入时算好存进 `fields`，同时写入 `dt_change_fields` 供字段筛选走索引。

```json
{
  "seq": 1042, "op": "update", "domain": "proj_a",
  "table": "task", "record_id": 13, "actor": "claude", "ts": "…",
  "fields": {"status": {"before": "进行中", "after": "完成"}},
  "record": {"_id": 13, "status": "完成", "…": "…"}
}
```

- `fields` 只含实际变化的用户字段；insert 是 null → 值，delete 是值 → null。
- 一次更新改多个字段仍是一条事件；批量插入、级联删除是每条记录一条。
- `dt event list/watch` 可以按表、字段、op、记录过滤。`watch` 每行一个 JSON，按游标续拉，不会漏事件。

### 绑定

```yaml
name: notify-done
ops: [update]              # insert / update / delete，默认全部
table: task                # 省略表示整个域
field: status              # 省略表示表内任意字段；指定时必须写 table
where: {status: 完成}       # 变化后的值；delete 用变化前
where_before: {status: 待办} # 可选，变化前的值
prompt: "任务 ${record.title} 完成了，请检查产出并更新下游。"  # 可选，随投递一起给消费方
action: webhook
config: {url: "http://127.0.0.1:9000/hook"}
enabled: true
```

匹配顺序：域 → 操作类型 → 表 → 字段实际出现在 `fields` 里 → `where` / `where_before`。

### 动作

| action | config | 说明 |
|---|---|---|
| `webhook` | `{url, headers?, secret?, timeout?}` | POST `{binding, delivery_ids, event_count, events}`；只有一条事件时额外带 `delivery_id` / `event`。请求头带 `X-DT-Delivery`（逗号分隔）、`X-DT-Event-Seq`、`X-DT-Event-Count`、`X-DT-Binding`，配置 `secret` 时加 HMAC-SHA256 的 `X-DT-Signature` |
| `command` | `{cmd, timeout?, cwd?}` | `sh -c` 执行，事件 JSONL（每行一条）从 stdin 传入；环境变量 `DT_BINDING`、`DT_DOMAIN`、`DT_OP`、`DT_TABLE`、`DT_RECORD_ID`、`DT_EVENT_SEQ`（第一条）、`DT_EVENT_COUNT` |
| `write` | `{table, mode?, record_id?, parent_id?, data}` | 在同一个域里写回记录。`mode` 默认 `insert`，`update` 需要 `record_id`。字符串里可用 `${event.seq}`、`${record.title}`、`${fields.status.after}` 等模板；批量事件在一个事务里逐条执行 |
| `inbox` | `{title?, body?}` | 写入当前域的收件箱。每个事件一条消息；`title` / `body` 支持同样的模板，留空使用默认摘要（表名、记录 id、字段变化） |

所有 action 的 config 还支持：

- `batch`：一次动作最多合并多少条投递，默认 20，最大 1000。同一事务、同一绑定的事件会先合并成一条投递，超过 1000 条拆成多条。
- `max_pending`：该绑定允许积压的待投递条数，默认 50000。达到上限后新事件会跳过并写服务日志。

绑定的顶层 `prompt` 是一段给消费方的提示词，支持 `${record.title}`、`${fields.status.after}` 等模板：

- `webhook`：放在 payload 的 `prompt` 字段；`command`：通过 `DT_PROMPT` 环境变量传入；`inbox`：存到消息的 `prompt` 并在收件箱展示。
- webhook / command 一次可能带多条事件，`prompt` 用第一条事件渲染；inbox 每条消息各自用对应事件渲染。
- 留空或渲染结果为空时不发送；`write` 动作没有消费方，忽略 `prompt`。

- 投递发生在 `dt serve` 进程内，事务提交后由后台任务执行；服务没开时投递会留在 `pending`，下次启动继续。调度器处理到活就立即继续，不再固定等 0.5s。
- 同一绑定按 `seq` 顺序投递；失败退避 1s / 5s / 30s / 2m / 10m / 30m / 1h，超过后标 `failed`，可 `dt event retry`。
- 每次投递的动作结果记在 `last_result`（webhook 的 `HTTP <code>`、command 的退出码、write / inbox 的写入条数）；`failed` / `pending` 时为 null，错误信息在 `last_error`。
- `dt serve` 会为每次投递打一行日志：`INFO 投递 #12 绑定 notify-done（webhook）2 条事件 → HTTP 200，38ms`；失败打 WARNING，带第几次尝试和错误。
- 语义是 at-least-once：接收方按 `X-DT-Delivery`（或事件 `seq`）去重。
- `write` 动作自己写库时不会再触发绑定，避免回环。
- `command` 会以服务进程身份执行本机命令，只应在本地单人环境里配置可信命令。
- `sent` 投递保留 7 天、`failed` 保留 30 天，后台每小时清理一次；`pending` 不受清理影响。
- `inbox` 消息按 `(binding_id, event_seq)` 去重，重试不会重复写入；消息里的 `events` 保存完整事件快照，`prompt` 是绑定提示词按该事件渲染的结果，读状态用 `status` / `read_at`。收件箱消息不会被自动清理，需要时用 `dt inbox delete` 或页面删除。

### 性能相关

- 一次写事务只查一次绑定（`Tx.binding_cache`），批量写入不会逐条查库。
- 同一事务同一绑定的事件在内存里合并，`Tx.flush()` 时一次写成投递，避免 O(n²) 的 JSON 更新。
- 字段筛选使用 `dt_change_fields(field, seq)` 索引；5 万条变更里筛一个冷门字段，从数秒降到毫秒级。
- 旧库升级时会自动补 `fields` 列和 `dt_change_fields`，并在启动时一次性回填历史记录事件。

## 14. 知识图谱

侧边栏「图谱」进入（路由 `#域/@graph`）。一个域一张图，数据全部来自已有的记录和变更，不新建存储。

### 图的模型

| 元素 | 来源 | 样式 |
|---|---|---|
| 记录节点 | `dt_records` | 按表着色，子表节点小一号；大小随连接数增长；标题取第一个有值的文本字段，否则 `#id` |
| 操作者节点 | `dt_changes.actor` | 方块，按操作者颜色；默认隐藏，在「连线」里打开 |
| 父子边 | `_parent_id`，父 → 子 | 实线 |
| 引用边 | link 字段的值，持有方 → 被引用方 | 虚线加箭头，悬停显示字段名 |
| 操作边 | 操作者对记录做过的 insert / update，操作者 → 记录 | 细线，悬停显示次数 |

### 两个视图

- **记录图**：记录和操作者作为节点。域内记录不超过 1500 条时默认进入这个视图。
- **表概览**：表作为节点，父子和 link 关系作为边，边上标注条数；顶部显示孤立记录总数，悬停表节点显示该表的孤立数。超过 1500 条时默认进入；点一张表进入只含这张表的记录图。

### 实时变化

复用 `/api/ws` 变更流，只应用 `seq` 大于快照 `seq` 的变更；表结构变化时重新拉图。

| 变更 | 表现 |
|---|---|
| insert | 新节点在父节点或被引用节点旁出现，外圈闪操作者颜色 |
| update | 外圈脉冲，旁边短暂显示「操作者 · 改动字段」；link 值变化时新边高亮，旧边变红淡出 |
| delete | 节点变红淡出，相连的边一起去掉 |

底部活动带显示最近 20 条记录变更，点击定位到节点。着色可在「按表」和「按最后操作者」（`_updated_by`）之间切换。

### 筛选

- 表：图例里点表切换范围，范围变化时重新拉图。
- 焦点：搜索（可直接输入 `_id`）或双击节点设为中心。由 `/graph/related` 在整个域上计算，不受 3000 条快照的限制；深度 1–3 跳或「全部」，方向可选双向、它指向的、指向它的；只沿「连线」里打开的父子和 link 边、在当前表范围内遍历。右侧列出关联记录，按跳数分组，说明经哪条边到达。关联记录有变更时静默重拉。
- 路径：选中一个节点后 Shift+单击另一个节点，调用 `/graph/path`，路径上的边高亮，顶部显示每一步。
- 连线：父子、每个 link 字段、操作边分别开关。
- 操作者：只显示选中操作者 insert / update 过的记录。
- 时间：只显示最近 1 小时 / 24 小时更新过的记录。
- 筛选状态写在地址栏，例如 `#teams/@graph?tables=task,agent&focus=12&depth=2&actors=claude`。

单击节点高亮它和直接邻居，并在右侧打开记录抽屉；单击操作者节点切换按该操作者筛选。

- 枢纽：筛选行的「枢纽」菜单按当前表范围和连线开关列出连接最多的 15 条记录，点一条设为焦点。
- 拖线建 link：按住 Alt 把一条记录拖到另一条上，拖动时画虚线并圈出松手就会连上的目标，其他节点临时固定不动。松手后列出两条记录之间可用的 link 字段（任一方向）：多值字段追加，单值字段标出会替换掉的旧值，已引用的置灰。写入带 `if_version`，期间记录被改过时提示冲突。拖动节点本身回到原位。
- 历史回放：标题旁的回放按钮打开时间轴，范围是域内第一条到最后一条记录变更的 seq。拖动时间轴停手 250ms 后按 `at=<seq>` 重新拉那一刻的图；播放时从当前位置起逐条拉取 `dt_changes`，每条记录变更停 450ms，复用实时变化的脉冲和活动带。回放期间不应用实时变更（只延长时间轴终点），焦点、拖线不生效；换表范围、切到表概览或表结构变化时退出回放。

记录抽屉里有「关联」区块，列出它引用的和引用它的记录（link 字段），并可跳到以它为焦点的图谱。删除记录前调用 `impact`，确认框里列出会级联删除的子记录和会被去掉引用的记录；被 restrict 子表挡住时直接提示。

### 接口

`GET /api/d/{domain}/graph?tables=a,b&limit=3000`

```json
{"seq": 1042, "total": 888, "truncated": false,
 "nodes": [{"id": 12, "table": "task", "title": "写设计", "parent_id": 3,
            "created_by": "claude", "updated_by": "codex", "updated_at": "…"}],
 "edges": [{"source": 3, "target": 12, "kind": "parent"},
           {"source": 12, "target": 7, "kind": "link", "field": "agent"}],
 "touches": [{"actor": "claude", "record_id": 12, "count": 3}],
 "table_edges": [{"source": "job", "target": "task", "kind": "parent", "count": 534},
                 {"source": "task", "target": "agent", "kind": "link", "field": "agent", "count": 520}]}
```

- `tables` 省略表示整个域；`limit` 默认 3000、最大 10000，超过时只保留最近更新的记录，`truncated` 为 true。`limit=0` 只返回 `table_edges`、`orphans` 和 `total`，给表概览用。
- `edges` 和 `touches` 只包含两端都在 `nodes` 里的边；`table_edges` 和 `orphans`（每张表没有任何父子或 link 关系的记录数）统计整个域。
- `at=<seq>` 返回那一刻的图：每条记录取 seq 不超过 `at` 的最后一次变更的 `after`，最后一次是 delete 的跳过；`touches` 也只算到 `at`。按当前表结构解释旧数据，已删除的表不出现。返回的 `seq` 等于 `at`，另带 `timeline: {first_seq, last_seq, at_ts}`。
- `format=mermaid|dot` 时（`/graph`、`related`、`path` 都支持）返回 `{format, text}`：节点按表分组，父子边实线，link 边虚线并标字段名。
- 下面这些接口都在整个域上计算，不受 `limit` 截断影响。连线类型 `kinds` 逗号分隔：`parent`、`link`（全部 link 字段）、`link:<表>.<字段>`；操作者边不参与遍历。`direction=out` 沿父→子、引用方→被引用方走，`in` 反过来。

`GET /api/d/{domain}/graph/related?ids=12&depth=all&direction=in&kinds=link`

```json
{"seq": 1042, "seeds": [12], "truncated": false,
 "nodes": [{"id": 12, "table": "task", "title": "写设计", "depth": 0, "via": null, "…": "…"},
           {"id": 15, "table": "task", "title": "实现", "depth": 1,
            "via": {"from": 12, "dir": "in", "source": 15, "target": 12, "kind": "link", "field": "needs"}}],
 "edges": [{"source": 15, "target": 12, "kind": "link", "field": "needs"}],
 "touches": [{"actor": "claude", "record_id": 12, "count": 3}]}
```

- `ids` 和 `actor` 至少给一个；`actor` 把它 insert / update 过、现在还在的记录也作为起点。`depth` 默认 1，`all` 表示不限；`limit` 默认 500、最大 5000，超出时 `truncated` 为 true。`tables` 限定只经过哪些表，起点不受限。
- `where`（查询 DSL 的 JSON）和 `since`（seq）只筛选返回的记录，不影响遍历，起点总是保留；`edges` 只含筛选后两端都在的边。`where` 用到的字段在某张表里不存在时，这张表的记录都算不满足，所有表都没有时报 `invalid_query`。`since` 给出时每个节点带 `changed: {count, last_seq, last_ts, ops, actors, fields}`（起点没变化时为 null）。
- `fields=*` 时每个节点带 `data`（和 `rec get` 一样的完整记录），`fields=a,b` 只带这些 key。
- `path` 返回 `{found, nodes, edges}`，`edges` 按路径顺序，每条带 `dir`。
- `lint` 返回 `dangling`（link 指向的记录不存在，通常是绕过接口写入的老数据）、`orphans`（没有父子也没有 link 关系）和 `cycles`（自引用 link 字段里成环的记录，含自己依赖自己），各自 `{total, items}`。
- `impact` 返回 `record`、`cascade`（会一起删的子记录）、`unlink`（会被去掉引用的记录和字段）、`blocked`（restrict 子表挡住删除时非空）。

### 依赖

一个 link 字段可以看成「持有方依赖被引用方」，最常见的是自引用的 `task.needs → task`。`field` 写成 `<表>.<字段>`，不是 link 字段时报错并列出可用的 link 字段。悬空的依赖不算阻塞（用 `lint` 检查）。

- `ready?field=task.needs&done={"status":"完成"}` 返回 `ready`（自己不满足 `done`、依赖全部满足 `done`）和 `blocked`（还有依赖没完成，带 `waiting` 和 `in_cycle`），各自 `{total, items}`，另有已完成数 `done`。`where` 只筛选候选记录；`fields` 同 `related`。
- `order?field=task.needs` 用 Kahn 算法给出拓扑序：被依赖的在前，`level` 是最长依赖链的层数，同层之间没有依赖。`ids` 给出时只排这些记录和它们（间接）依赖的记录；`done` 给出时已完成的记录不参与排序，也不再算作依赖。排不出来的记录放进 `stuck`，其中的环放进 `cycles`（Tarjan 强连通分量），`complete` 为 false。
- `hubs` 按连接数（`in` + `out`，只算 `kinds` 里的边）列出记录，同数按被指向的边数排。

- v1 不做：跨域图、保存布局、同值连接、在图上删除 link（在记录抽屉里改字段）。
