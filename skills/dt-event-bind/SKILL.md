---
name: dt-event-bind
description: 在 dt 的域/表/字段上创建、修改、启停、删除记录事件绑定（订阅）：监听 insert/update/delete、字段级变化、where/where_before 条件，命中后执行 webhook、本机 command、写回记录（write）或投递到收件箱（inbox）。用户说「监听任务状态」「状态变成完成时通知/放进收件箱」「创建 event / 事件订阅 / 绑定事件」「事件触发命令/webhook」「暂停/修改/删除绑定」「看投递失败」时使用。消费事件流用 dt-event-consume。
---

# dt 事件绑定

dt 的记录事件由写入自动产生（insert / update / delete，表结构变更不算）。所谓「创建事件」，实际是创建一条**绑定**：规定在什么范围、什么操作、什么字段变化、满足什么条件时，执行什么动作。

绑定会调用外部 webhook 或本机命令，属于有副作用的操作：用户没有明确要求时不要创建；创建前把目标地址、命令或写回目标告诉用户确认。

## 必带参数

- `-D <域>`：除 `dt domain ...` 外每条命令都要写。dt 不读环境变量里的域。
- `-A <你的名字>`：`bind` / `update` / `unbind` / `retry`，以及 `dt inbox read` / `unread` / `read-all` / `delete` 都是写入命令，必须写，例如 `-A claude`。只有 `binds` / `deliveries` / `inbox list` 这类读取不需要。

所有命令输出 JSON：成功 `{"ok": true, "domain": "...", "data": ...}`，失败 `{"ok": false, "error": {"code", "message", "hint"}}`，按 `hint` 修正后重试。

## 流程

### 1. 确认作用范围

```bash
dt domain show proj_a              # 表、描述、子表树（不含字段）
dt table show task -D proj_a       # 字段 key、类型、选项、描述
```

绑定只能引用域里已有的表和字段，`--field` 必须配合 `--table`。字段用 `key`，不要写 `label`。

### 2. 把触发条件和动作定清楚

先看需要监听什么：

- 操作：`insert` / `update` / `delete`，默认全部
- 表：省略表示整个域
- 字段：省略表示任意字段；指定后只在**该字段实际变化**时命中
- `where`：变化后的记录满足的条件（delete 看变化前）
- `where_before`：变化前的记录满足的条件
- `prompt`：可选，随动作给消费方的一段提示词（见下文「提示词」）
- 动作：`webhook` / `command` / `write` / `inbox`

典型条件：

```bash
# 状态从「待办」变成「完成」
--on update --table task --field status \
--where '{"status":"完成"}' --where-before '{"status":"待办"}'

# 新任务（标题任意）
--on insert --table task

# 某个任务下的日志新增
--on insert --table task_log
```

条件语法和查询 DSL 一样：`eq ne gt gte lt lte in nin contains is_null`、`$and` / `$or`，见 dt-data 的 `references/query.md`。

### 3. 选择动作

**webhook**：POST 事件到 URL。

```bash
dt event bind -D proj_a -A claude notify-done \
  --on update --table task --field status \
  --where '{"status":"完成"}' \
  --action webhook \
  --config '{"url":"http://127.0.0.1:9000/hook"}'
```

**command**：以服务进程身份执行本机命令，事件 JSONL 从 stdin 传入。

```bash
dt event bind -D proj_a -A claude log-events \
  --on insert --table task \
  --action command \
  --config '{"cmd":"cat >> /tmp/dt-events.jsonl"}'
```

**write**：在同一个域里插入或更新记录。

```bash
# 状态变成完成时，写一条任务日志
dt event bind -D proj_a -A claude auto-log \
  --on update --table task --field status \
  --where '{"status":"完成"}' \
  --action write \
  --config '{"table":"task_log","parent_id":"${event.record_id}","data":{"content":"任务 ${record.title} 已完成"}}'

# 把同一条任务的字段补上（更新模式需要目标记录的 _id）
dt event bind -D proj_a -A claude mark-reviewed \
  --on update --table task --field status \
  --where '{"status":"完成"}' \
  --action write \
  --config '{"table":"task","mode":"update","record_id":"${event.record_id}","data":{"reviewed":true}}'
```

**inbox**：把命中的事件放进当前域的收件箱，人在页面「收件箱」里看，agent 用 `dt inbox list` 读。

```bash
dt event bind -D proj_a -A claude inbox-done \
  --on update --table task --field status \
  --where '{"status":"完成"}' \
  --action inbox \
  --config '{"title":"${record.title} 完成了","body":"${fields.status.before} → ${fields.status.after}"}'

dt inbox list -D proj_a --status unread
dt inbox read -D proj_a -A claude 12
dt inbox read-all -D proj_a -A claude
```

- 每个事件一条收件箱消息；`title` / `body` 留空时使用默认摘要。
- inbox 动作只写本地库，不调用外部服务；仍然是异步投递，稍等片刻或在页面刷新/等待自动刷新。
- 收件箱消息按绑定 + 事件去重，重试不会重复；消息不会自动过期，可 `dt inbox delete` 删除。

**提示词**：`--prompt '任务 ${record.title} 已完成，请检查产出并更新下游。'` 可选，让消费方知道要做什么，而不只是收到数据变化。

- webhook：payload 的 `prompt` 字段；command：`DT_PROMPT` 环境变量；inbox：消息的 `prompt`，页面和 `dt inbox list` 都能看到。
- 支持和 `title` / `body` 一样的模板；一次带多条事件时，webhook / command 用第一条事件渲染，inbox 每条消息各自渲染。
- 修改用 `dt event update -D <域> -A <你的名字> <name> --prompt '...'`，传空字符串清除。

完整的 config 字段、webhook payload、模板变量见 [references/actions.md](references/actions.md)。

### 4. 创建并验证

```bash
dt event binds -D proj_a                     # 列出当前域的绑定，核对 ops / 表 / 字段 / 条件 / 动作
dt event deliveries -D proj_a notify-done    # 看投递状态、last_result（HTTP 状态码 / 退出码 / 写入条数）；failed 可用 retry 重试
dt event retry -D proj_a -A claude notify-done
dt inbox list -D proj_a --status unread      # inbox 动作看消息是否写入
```

想先建但不触发，可以加 `--disabled`；确认后再启用：

```bash
dt event update -D proj_a -A claude notify-done --enabled
```

验证时尽量只做一次小范围、可回滚的记录变更；不要为了测试绑定批量写数据。测试前先告诉用户会改哪条记录。

### 5. 修改、停用、删除

```bash
dt event update -D proj_a -A claude notify-done --where '{"status":"评审"}'
dt event update -D proj_a -A claude notify-done --disabled
dt event update -D proj_a -A claude notify-done --enabled
dt event unbind -D proj_a -A claude notify-done
```

- 只传要改的项；改 `--action` 时通常要同时传新的 `--config`。
- 清除条件传空字符串：`--where ''`、`--where-before ''`、`--prompt ''`。
- 把绑定改成整个域：`--table '' --field ''`。
- `unbind` 会删除绑定及其投递记录；只是想暂时停用用 `--disabled`。

## 匹配规则

- 一个写操作可能同时命中多条绑定，每条绑定各自产生投递。
- `update` 的字段订阅只在该字段出现在 `fields` 里时命中；`insert` / `delete` 时该字段有值就算。
- `where` 对 insert/update 看变化后的记录，对 delete 看变化前的记录。
- 绑定只对**创建之后**的事件生效，不会回溯历史事件。
- 同一事务、同一绑定的事件会合并成一条投递（最多 1000 条事件，超出拆条）；调度时还会按 `batch` 合并最多 20 条投递。一次 webhook/命令可能收到多条事件，见 references。

## 安全与边界

- **command 会执行本机 shell**，以 `dt serve` 进程身份运行；只能使用可信命令，不要把用户输入直接拼进 `cmd`。
- webhook 会向目标 URL 发送记录内容；确认目标可信、允许接收这些数据。
- config 明文存在本地 SQLite 里；`secret` 用于 HMAC 签名，不是加密。
- `write` 动作自己写库时不会再触发绑定，避免直接回环；但 command/webhook 如果通过 dt CLI 写数据，仍会产生新事件，注意过滤条件，避免 A→B→A。
- 每个绑定有 `max_pending`（默认 50000）；积压到上限后新事件会被跳过并写服务日志。高频批量写入时用字段/条件收窄范围，或调大 `batch`。
- `sent` 投递保留 7 天、`failed` 保留 30 天；需要保留更久就自己消费事件流（dt-event-consume）。

## 常见错误

- `invalid_binding`：条件/字段/动作配置不合法；看 `hint`，必要时先 `dt table show` 核对字段 key。
- `already_exists`：同名绑定已存在；用 `dt event update`，或先确认后 `unbind` 再重建。
- `not_found`：绑定不存在；`dt event binds` 查看已有名字。
- 绑定创建成功但投递失败：`dt event deliveries` 看 `last_error`，修复后 `dt event retry`。
