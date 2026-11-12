---
name: dt-data
description: 用 dt CLI 读写动态表格里的数据：先查域、再按描述挑表、看字段说明，然后查询、插入（含子表嵌套、批量）、更新、删除、挂附件（agent 产出物的绝对路径）、看变更历史、查记录之间的关联。用户说「记一条任务」「查一下进行中的任务」「把任务改成完成」「写一条日志」「把产出物挂到任务上」「看看某个项目里有什么数据」「这个任务关联了哪些东西」「谁引用了它」时使用。建域、建表、改字段用 dt-schema。
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

dt rec impact task 12 -D proj_a                 # 删除前预览：会级联删哪些、会改掉谁的引用、是否被 restrict 挡住
dt rec delete task 12 -D proj_a -A claude       # 子记录按 on_delete 级联删除；返回里的 unlinked 是被去掉引用的记录
dt history -D proj_a --table task --id 12       # 这条记录的变更历史
```

`--data`、`--set`、`--where` 都可以写 JSON 字符串、`@文件路径` 或 `-`（从 stdin 读）。内容复杂或含引号时写到文件里用 `@file.json`。查询语法见 [references/query.md](references/query.md)。

### 5. 查关联（需要时）

记录之间的关系有三种：父子（`_parent_id`）、link 字段，以及同值关联（表结构里声明了同一个 `config.match` 的字段值相同，由 dt-schema 设置，不用手动写）。`dt graph` 在整个域上沿这些关系查找，不用自己一层层 query。

```bash
dt graph related 12 -D proj_a                              # 和 12 直接相连的记录（1 跳）
dt graph related 12 -D proj_a --depth all --format table   # 能连到的所有记录
dt graph related 12 -D proj_a --direction in --kinds link  # 谁引用了 12
dt graph related 12 -D proj_a --kinds match                # 和 12 编号相同的记录（同值关联）
dt graph related 12 -D proj_a --direction out --kinds link:task.needs --depth all   # 12 依赖的整条链
dt graph related -D proj_a --by codex --depth 0            # codex 写过的记录
dt graph path 12 7 -D proj_a                               # 两条记录之间最短的关联路径
dt graph lint -D proj_a                                    # 悬空引用、孤立记录、依赖环、同值关联里有歧义没连上的值
dt graph hubs -D proj_a --format table                     # 连接最多的记录
```

- `--direction`：`out` 沿父→子、引用方→被引用方走；`in` 反过来；默认 `both`。
- `--kinds`：`parent`、`link`（全部 link 字段）、`link:<表>.<字段>`、`match`（全部同值关联）、`match:<名字>`，逗号分隔。同值关联的边带 `match`（名字）和 `value`（相同的值），方向是从多的一侧指向唯一的一侧。`--tables` 限定只经过哪些表。
- 返回的每条记录带 `depth`（离起点几跳）和 `via`（经哪条边、从哪条记录到达）。超过 `--limit`（默认 500）时 `truncated` 为 true，缩小 depth 或加 kinds、tables 再查。

把关联记录当上下文用时，直接带上数据、按条件筛，不用再逐条 `rec get`：

```bash
dt graph related 12 -D proj_a --depth all --fields '*'                         # 每条带完整字段（data）
dt graph related 12 -D proj_a --depth all --fields title,status --where '{"status":{"ne":"完成"}}'   # 只要没完成的
dt graph related 12 -D proj_a --depth 2 --since 1042 --format table            # seq 1042 之后周边谁被改过（带 changed 汇总）
dt graph related 12 -D proj_a --depth all --format mermaid                     # 导出成 Mermaid，贴进文档；也可以 --format dot
```

- `--where` 用查询 DSL，只筛返回的记录，不挡遍历；起点总是保留。字段只在部分表里有时，其他表的记录算不满足。
- `--since` 的 seq 来自上次返回的 `seq`，或 `dt event list` 的游标。

### 依赖（自引用的 link，如 `task.needs → task`）

```bash
dt graph ready -D proj_a --field task.needs --done '{"status":"完成"}' --format table   # 现在能开工的；blocked 列出还在等谁
dt graph ready -D proj_a --field task.needs --done '{"status":"完成"}' --where '{"_created_by":"claude"}'   # 只看 claude 建的
dt graph order -D proj_a --field task.needs --done '{"status":"完成"}' --format table   # 拓扑序，level 相同可并行
dt graph order 12 -D proj_a --field task.needs          # 只排 12 和它（间接）依赖的
```

- `--field` 写 `<表>.<字段>`，持有方依赖被引用方。`--done` 是「已完成」的条件，必填（`ready`）。
- 依赖成环时 `ready` 里对应记录 `in_cycle` 为 true，`order` 把它们放进 `cycles` / `stuck`，`lint` 的 `cycles` 也会列出；把环上某条的依赖去掉再排。

### 6. 订阅记录变化（需要时）

`dt event` 只订阅记录的 `insert` / `update` / `delete`，事件带字段级 `fields`（before/after），表结构变化不算事件。

```bash
# 查看历史事件；--field 只看该字段实际变化的事件
dt event list -D proj_a --table task --field status --op update --since 100

# 持续监听，每行一个 JSON；按 seq 游标续拉，不会漏
dt event watch -D proj_a --table task --field status --op update --since 100 --timeout 60
```

- 「状态变成完成时通知/写日志/放进收件箱」这类自动动作是**绑定**，用 **dt-event-bind**。绑定会执行 webhook 或本机命令，用户没有明确要求时不要创建。
- 按游标持续消费事件、读收件箱用 **dt-event-consume**。

## 规则

- 记录用 `_id` 定位。`_id` 从 insert 或 query 的返回里取，不要自己编；它只在自己的域里能访问到。
- `_` 开头的是只读系统字段（`_id` `_parent_id` `_version` `_created_at` `_updated_at` `_created_by` `_updated_by`），可以用来查询和排序。
- 人可能同时在页面上编辑同一条记录。先读后改时把读到的 `_version` 传给 `--if-version`；返回 `version_conflict` 时重新读取再决定。
- 附件只记录路径，不复制文件，所以要传最终位置的绝对路径，不要传临时文件。
- 删除前先 `dt rec impact` 看清会级联删掉什么、会改掉哪些记录的引用；用户没明确要求删除时先确认。
- 子表记录必须有父记录：用 `--parent`，或者嵌套在父记录里插入。
