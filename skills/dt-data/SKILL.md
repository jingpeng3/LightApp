---
name: dt-data
description: 用 dt CLI 读写动态表格里的数据：先查域、再按描述挑表、看字段说明，然后查询、插入（含子表嵌套、批量）、更新、删除、挂附件（agent 产出物的绝对路径）、看变更历史。用户说「记一条任务」「查一下进行中的任务」「把任务改成完成」「写一条日志」「把产出物挂到任务上」「看看某个项目里有什么数据」时使用。建域、建表、改字段用 dt-schema。
---

# dt 数据操作

数据分在多个**域**里（比如一个项目一个域），每个域有多张表，表下面可以有多级子表。你不需要预先知道表结构：按「域 → 表 → 字段」一层层往下看，每层只拿当前需要的信息。

## 两个必带参数

- `-D <域>`：除 `dt domain ...` 外每条命令都要写。dt 不读环境变量里的域，没写就报错。
- `-A <你的名字>`：所有写入命令都要写（insert、update、attach、delete），例如 `-A claude`。页面和变更历史靠它显示是谁改的。

每次调用都显式写这两个参数，不要依赖 `export`：你的每条命令可能运行在新的 shell 里。

所有命令输出 JSON：成功 `{"ok": true, "domain": "...", "data": ...}`，失败 `{"ok": false, "error": {"code", "message", "hint"}}`，退出码 1。失败时按 `hint` 修正后重试，不要猜。成功时核对返回里的 `domain` 是不是你要操作的域。

## 流程

### 1. 选域

```bash
dt domain list
```

返回每个域的 `name`、`label`、`description`、表数和记录数。根据用户的话和 `description` 确定域。对不上或者有多个候选时先问用户，不要自己挑一个写进去。

### 2. 看域里有哪些表

```bash
dt domain show proj_a
```

返回域里每张表的 `name`、`label`、`description`、记录数，以及子表树（`children`，带 `relation`：`one_to_many` 一对多，`one_to_one` 一对一）。这里**不含字段**。根据 `description` 判断用户说的东西对应哪张表；子表的数据挂在父表的某条记录下面。

### 3. 看要用的表的结构

```bash
dt table show task -D proj_a
```

只看你要读写的表。返回每个字段的 `key`、`type`、`label`、`description`、`required`、`default`、`options`（下拉选项）、`config`（link 指向哪张表、附件是否多值），以及子表概要。

- 按 `description` 理解字段含义和填写规则，按 `key` 写入，不要用 `label` 当 key。
- 下拉字段只能写 `options` 里的值。没有合适的选项时告诉用户，或者用 dt-schema 去加，不要换个近似值。
- 要嵌套写入子表时，再对子表 `dt table show` 一次。
- 同一会话里结构没变就不用重复看。写入返回 `unknown_field` 或选项错误时，说明结构可能刚被改过，重新 show。

### 4. 读写数据

```bash
# 查询
dt rec query task -D proj_a --where '{"status":{"in":["待办","进行中"]}}' --sort -_updated_at --limit 20
dt rec query task_log -D proj_a --parent 12                          # 某条任务下的日志
dt rec get task 12 -D proj_a --include task_log,task_log.log_note,task_board

# 插入。data 里用子表名作 key 可以一起插入子记录：one_to_many 传数组，one_to_one 传对象
dt rec insert task -D proj_a -A claude --data '{"title":"写设计","status":"进行中","task_log":[{"content":"开始"}]}'
dt rec insert task_log -D proj_a -A claude --parent 12 --data '{"content":"完成初稿"}'
cat rows.jsonl | dt rec insert task -D proj_a -A claude --batch       # 一条失败全部回滚

# 更新：只传要改的字段，设为 null 表示清空
dt rec update task 12 -D proj_a -A claude --set '{"status":"完成"}' --if-version 3

# 附件：传绝对路径，文件或目录都可以
dt rec attach task 12 output /abs/path/report.md /abs/path/site -D proj_a -A claude   # 追加
dt rec update task 12 -D proj_a -A claude --set '{"output":["/abs/path/report.md"]}'  # 整体替换

dt rec delete task 12 -D proj_a -A claude       # 子记录按 on_delete 级联删除
dt history -D proj_a --table task --id 12       # 这条记录的变更历史
```

`--data`、`--set`、`--where` 都可以写 JSON 字符串、`@文件路径` 或 `-`（从 stdin 读）。内容复杂或含引号时写到文件里用 `@file.json`。查询语法见 [references/query.md](references/query.md)。

### 5. 订阅记录变化（需要时）

`dt event` 只订阅记录的 `insert` / `update` / `delete`，事件带字段级 `fields`（before/after），表结构变化不算事件。

```bash
# 查看历史事件；--field 只看该字段实际变化的事件
dt event list -D proj_a --table task --field status --op update --since 100

# 持续监听，每行一个 JSON；按 seq 游标续拉，不会漏
dt event watch -D proj_a --table task --field status --op update --since 100 --timeout 60

# 绑定动作（写入命令要 -A）
dt event bind -D proj_a notify-done -A claude --on update --table task --field status \
  --where '{"status":"完成"}' --action webhook --config '{"url":"http://127.0.0.1:9000/hook"}'
dt event bind -D proj_a auto-log -A claude --on update --table task --field status \
  --action write --config '{"table":"task_log","parent_id":"${event.record_id}","data":{"content":"状态已更新"}}'
dt event binds -D proj_a
dt event deliveries -D proj_a notify-done [--status failed]
dt event retry -D proj_a notify-done
```

- `where` 看变化后的记录（delete 看变化前），`--where-before` 看变化前；两者都和查询 DSL 一样。
- `write` 的 `data` 字符串里可用 `${event.record_id}`、`${event.seq}`、`${record.title}`、`${fields.status.after}`。
- 同一事务、同一绑定的事件会合并成一条投递；一次命令/一次 webhook 可能收到多条事件。command 的 stdin 是 JSONL（每行一条事件），webhook 的 `events` 是数组。config 里可用 `batch`（默认 20，一次动作合并几条投递）和 `max_pending`（默认 50000）。
- 绑定会执行 webhook 或本机命令；**用户没有明确要求时不要创建绑定**。创建前把动作、目标地址和执行内容告诉用户确认。
- 更完整的订阅创建、修改、启停、投递重试用 **dt-event-bind**；持续消费事件流用 **dt-event-consume**。

## 规则

- 记录用 `_id` 定位。`_id` 从 insert 或 query 的返回里取，不要自己编；它只在自己的域里能访问到。
- `_` 开头的是只读系统字段（`_id` `_parent_id` `_version` `_created_at` `_updated_at` `_created_by` `_updated_by`），可以用来查询和排序。
- 人可能同时在页面上编辑同一条记录。先读后改时把读到的 `_version` 传给 `--if-version`；返回 `version_conflict` 时重新读取再决定。
- 附件只记录路径，不复制文件，所以要传最终位置的绝对路径，不要传临时文件。
- 删除前先 `dt rec get ... --include <子表>` 看清会级联删掉什么；用户没明确要求删除时先确认。
- 子表记录必须有父记录：用 `--parent`，或者嵌套在父记录里插入。
