# 事件绑定的动作配置

绑定由 CLI 创建后保存在 `dt_bindings`；动作配置是 `config` 里的 JSON。所有动作都支持：

| 键 | 默认 | 说明 |
|---|---|---|
| `batch` | `20` | 一次动作最多合并多少条投递 |
| `max_pending` | `50000` | 该绑定允许积压的 pending 投递数；达到上限后新事件跳过 |

`batch` / `max_pending` 可以写在任何动作的 config 里。

绑定的顶层 `prompt`（CLI 的 `--prompt`）是可选的一段提示词，随动作一起给消费方，让接收方知道要做什么，而不只是收到数据变化。支持和 `title` / `body` 一样的模板：

- `webhook`：放在请求 body 的 `prompt` 字段。
- `command`：通过 `DT_PROMPT` 环境变量传入。
- `inbox`：存到收件箱消息的 `prompt`，页面和 `dt inbox list` 都能看到。
- `write` 没有消费方，忽略 `prompt`。
- webhook / command 一次可能带多条事件，`prompt` 用第一条事件渲染；inbox 每条消息各自用对应事件渲染。留空不发送。

## webhook

```json
{
  "url": "http://127.0.0.1:9000/hook",
  "headers": {"X-Token": "..."},
  "secret": "hmac-secret",
  "timeout": 10
}
```

- `url` 必填，只接受 `http` / `https`。
- `headers` 可选，字符串键值。
- `secret` 可选：对请求 body 做 HMAC-SHA256，结果放在 `X-DT-Signature`。
- `timeout` 默认 10 秒，范围 1–600。

请求 body：

```json
{
  "binding": "notify-done",
  "delivery_ids": [12, 13],
  "event_count": 2,
  "prompt": "任务 写设计 完成了，请检查产出并更新下游。",
  "events": [
    {"seq": 1042, "op": "update", "...": "..."},
    {"seq": 1043, "op": "update", "...": "..."}
  ]
}
```

配置了 `prompt` 时才有 `prompt` 字段；有模板时用第一条事件渲染。

只有一条事件时，额外带旧字段：

```json
{
  "binding": "notify-done",
  "delivery_id": 12,
  "event": {"seq": 1042, "op": "update", "...": "..."}
}
```

请求头：

- `X-DT-Binding`
- `X-DT-Delivery`：逗号分隔的 delivery id
- `X-DT-Event-Seq`：第一条事件的 seq
- `X-DT-Event-Count`
- `X-DT-Signature`（配置 secret 时）

接收方应按 `delivery_ids` 或事件 `seq` 去重；投递是 at-least-once。

## command

```json
{
  "cmd": "cat >> /tmp/dt-events.jsonl",
  "cwd": "/tmp",
  "timeout": 30
}
```

- `cmd` 必填，通过 `sh -c` 执行；以 `dt serve` 进程身份运行。
- `cwd` 可选。
- `timeout` 默认 30 秒，范围 1–600。
- stdin 是 **JSONL**：每行一个事件。只有一条时也是一行 JSON。
- 非 0 退出码视为失败，按退避重试。
- 环境变量：
  - `DT_BINDING`
  - `DT_DOMAIN`
  - `DT_EVENT_SEQ`（第一条）
  - `DT_EVENT_COUNT`
  - `DT_OP` / `DT_TABLE` / `DT_RECORD_ID`（第一条）
  - `DT_PROMPT`：绑定的提示词按第一条事件渲染；没配置时为空字符串

示例：把事件逐条写入文件。

```bash
dt event bind -D proj_a -A claude log-events \
  --on insert,update --table task \
  --action command \
  --config '{"cmd":"cat >> /tmp/task-events.jsonl"}'
```

## write

在绑定的同一个域里写记录。

```json
{
  "table": "task_log",
  "mode": "insert",
  "parent_id": "${event.record_id}",
  "data": {
    "content": "任务 ${record.title} 已更新",
    "level": "info"
  }
}
```

```json
{
  "table": "task",
  "mode": "update",
  "record_id": "${event.record_id}",
  "data": {"reviewed": true}
}
```

- `record_id` 是**目标记录自己的 `_id`**，不是父记录 id。更新别的表时，可以用固定 id，或从事件里的 link 字段取值，例如 `"${record.board_id}"`。

- `table` 必填，目标表必须在同一个域里。
- `mode` 默认 `insert`；`update` 必须给 `record_id`。
- insert 时 `parent_id` 可选；目标是子表且不写父记录会失败。
- 一批事件会在**同一个事务**里逐条执行；任何一条失败，整批回滚，投递进入重试。

### 模板

字符串里可以用 `${...}`，值来自当前事件：

| 模板 | 含义 |
|---|---|
| `${event.seq}` | 事件 seq |
| `${event.op}` | insert / update / delete |
| `${event.record_id}` | 事件记录 id |
| `${event.actor}` | 操作者 |
| `${record.<key>}` | 事件记录的字段值（insert/update 用 after，delete 用 before） |
| `${fields.<key>.before}` / `${fields.<key>.after}` | 该字段的变化前 / 后 |

规则：

- 整个字符串正好是一个 `${...}` 时保留原类型（数字、数组、对象）。
- 模板嵌在字符串中间时转成字符串。
- 取不到值是 `null`；`record_id` / `parent_id` 解析不出 id 时动作失败。
- 模板只从事件读取，不能访问其他记录；需要关联数据时先用 dt-data 查好，或在 command 里处理。

## inbox

把事件写进当前域的收件箱，人在页面「收件箱」里看，agent 用 `dt inbox list` 读。

```json
{
  "title": "${record.title} 完成了",
  "body": "${fields.status.before} → ${fields.status.after}"
}
```

- `title` / `body` 可选，支持和 write 一样的模板；留空使用默认摘要：
  - title：`表名 #记录id 新增/变更/删除`
  - body：逐字段的 `label：before → after`
- 每个事件一条消息；同一投递里有多条事件就写多条消息。
- 消息按 `(binding_id, event_seq)` 去重，投递重试不会重复。
- 消息字段：`title`、`body`、`prompt`、`events`（完整事件数组）、`status`（unread/read）、`binding_name`、`table_name`、`record_id`、`op`。
- 读取：

```bash
dt inbox list -D proj_a --status unread --limit 50
dt inbox read -D proj_a -A claude 12
dt inbox unread -D proj_a -A claude 12
dt inbox read-all -D proj_a -A claude
dt inbox delete -D proj_a -A claude 12
```

- 收件箱消息不会自动清理；`sent` / `failed` 投递的保留策略不影响消息。
- 页面侧栏有「收件箱」入口和未读角标；消息展开后可以直接打开对应记录。

## 批量与投递语义

- 同一事务、同一绑定命中的多条事件合并成一条投递，最多 1000 条，超出拆成多条。
- 调度时同一绑定最多合并 `batch` 条投递、一次动作最多 4000 条事件。
- webhook 用 `events` 数组，command 用 JSONL，write 在一个事务里循环。
- 同一绑定按事件 seq 顺序执行；一个慢动作会阻塞该绑定后面的投递。
- 失败退避：1s、5s、30s、2m、10m、30m、1h；超过后停在 `failed`，用 `dt event retry` 重排。
- 每次投递的结果记在 `last_result`（webhook 的 `HTTP 200`、command 的 `退出码 0`、write / inbox 的写入条数），错误在 `last_error`；`dt event deliveries` 能看到。
- `dt serve` 每次投递打一行日志（绑定、动作、事件条数、结果、耗时），失败打 WARNING，带尝试次数和错误。
- at-least-once：重试可能重复，接收方按 delivery id / seq 去重。
- `sent` 保留 7 天、`failed` 保留 30 天；pending 不清理。
