---
name: dt-schema
description: 用 dt CLI 设计和修改动态表格的模版（表结构）：建域、建表、加字段、下拉选项、附件字段、父子子表（多级嵌套）、表间引用、同值自动关联（config.match）。用户说「建一个项目/域」「建一张表」「设计任务表/日志表/看板表」「加个字段」「改下拉选项」「加子表」「改表结构」「让编号相同的记录自动关联」时使用。只操作数据（增删改查记录）时用 dt-data。
---

# dt 模版设计

`dt` 是本机的动态表格服务。数据分成多个**域**（比如一个项目一个域），每个域里有多张表；表名只在域内唯一，不同域可以有同名的表，数据互相隔离。一个表模版（YAML）定义一张表和它的子表树，一个域模版定义整个域里的所有表。

除 `dt domain ...` 外，每条命令都要写 `-D <域>`（dt 不读环境变量里的域）；所有写入命令（apply 不带 `--dry-run`、domain create、field add、drop）都要写 `-A <你的名字>`。每次调用都显式写，不要依赖 `export`。服务没启动时 CLI 会自动拉起。所有命令输出 JSON：成功 `{"ok": true, "domain": "...", "data": ...}`，失败 `{"ok": false, "error": {"code", "message", "hint"}}`，失败时按 `hint` 修正后重试。

## 流程

0. `dt domain list` 看已有的域。用户没说用哪个域时先问，不要自己挑一个写进去。新项目用下面的域模版一次建好。
1. `dt domain show <域>` 看域里已有的表和描述，避免重复建表；要改已有表时先 `dt table show <name> -D <域>` 拿到当前定义。
2. 把模版写成 YAML 文件（改已有表时，在 show 的结果上修改，**spec 里要写全部字段**，漏写的字段会被归档）。
3. `dt table apply -D <域> -f <file> --dry-run` 检查计划，并处理返回里的 `warnings`（缺描述的表和字段）。
4. 计划里没有 `"destructive": true` 时，去掉 `--dry-run`、加上 `-A <你的名字>` 执行。有破坏性变更时，先把计划告诉用户并确认，再加 `--force` 执行。

## 描述要写给 agent 看

读数据的 agent 不预先知道表结构，它先看 `dt domain show`（只有表名和表的 `description`），再看 `dt table show`（字段的 `label` 和 `description`），据此决定用哪张表、往哪个字段写什么。所以：

- **域和每张表都写 `description`**：一句话说清楚这里存的是什么、一条记录代表什么。例如「研发任务，一条记录是一项要交付的工作」。
- **字段写 `description`**，凡是光看名字会有歧义的都要写：取值含义（「完成指已合入主干」）、单位（「人天」）、格式和来源（「绝对路径，指向最终产出物」）、谁来填（「由 agent 填写」）。
- 下拉选项的值本身要能看懂，不要用缩写代号。
- apply 返回的 `warnings` 会列出缺描述的表和字段，执行前补上。

## 域模版

```yaml
name: proj_a              # 域名，规则同表名
label: 项目 A
description: 项目 A 的研发任务、执行日志和缺陷
tables:                   # 每一项都是一个完整的表模版（见下面），子表写在 children 里
  - name: task
    description: 研发任务，一条记录是一项要交付的工作
    fields: [...]
    children: [...]
  - name: bug
    description: 测试或线上发现的缺陷
    fields:
      - {key: task, type: link, config: {table: task, multiple: true}}   # link 只能引用同一个域里的表
      - {key: ticket_no, type: text, config: {match: ticket_no}}         # 和其他声明了 match: ticket_no 的字段值相同时自动关联
```

```bash
dt domain apply -f proj_a.yaml --dry-run          # 域不存在时计划里会有 create_domain
dt domain apply -f proj_a.yaml -A claude          # 声明式：已有的表按差异修改；模版里没写的已有表保持不变
dt domain show proj_a                             # 域里的表、描述和子表树（不含字段）
dt domain create proj_b --label 项目B --description '…' -A claude   # 建空域，之后逐张 dt table apply
dt domain drop proj_b --force -A claude           # 删除域和里面所有数据；不加 --force 只返回会删多少
```

拿同一份域模版改个 `name` 再 apply，就能给另一个项目开一套一样的表。

## 表模版示例

```yaml
name: task                # 表名：小写字母开头，只含小写字母、数字、下划线，域内唯一
label: 任务
description: 研发任务，一条记录是一项要交付的工作
fields:
  - {key: no, label: 编号, type: auto_number}
  - {key: title, label: 标题, type: text, required: true}
  - key: status
    label: 状态
    type: single_select
    options: [{value: 待办, color: gray}, {value: 进行中, color: blue}, {value: 完成, color: green}]
    default: 待办
    description: 任务进度；「完成」指代码已合入主干并通过验收
  - {key: tags, label: 标签, type: multi_select, options: [前端, 后端]}   # 选项可以只写值，颜色自动分配
  - {key: due, label: 截止, type: date, description: 计划完成日期}
  - {key: owner, label: 负责人, type: person, description: 负责的人或 agent 名字}
  - {key: output, label: 产出物, type: attachment, config: {multiple: true, accept: [.md, .png]}, description: 最终产出文件或目录的绝对路径}
children:
  - name: task_log
    label: 任务日志
    description: 任务执行过程中的进展和问题记录
    relation: one_to_many   # 默认；一个任务多条日志
    on_delete: cascade      # 默认；删任务时一起删日志。restrict 表示有子记录时禁止删除父记录
    fields:
      - {key: content, label: 内容, type: long_text, required: true}
    children:               # 可以继续嵌套
      - name: log_note
        label: 日志备注
        description: 对某条日志的补充说明
        fields: [{key: text, label: 备注, type: text}]
  - name: task_board
    label: 看板信息
    description: 任务在看板上的位置
    relation: one_to_one    # 每个任务最多一条
    fields:
      - {key: column, label: 看板列, type: single_select, options: [Backlog, Doing, Done]}
```

字段类型：`text` `long_text` `number` `date` `datetime` `checkbox` `single_select` `multi_select` `url` `email` `person` `auto_number` `link` `attachment`。字段属性和每种类型的细节见 [references/fields.md](references/fields.md)。

## 怎么选关系

- 子记录属于父记录、随父记录删除（日志、明细、附属信息）：子表，`one_to_many`。
- 每条父记录只有一份的扩展信息（看板位置、统计）：子表，`one_to_one`。
- 两张独立的表互相引用（Bug 关联任务）：`link` 字段，`config: {table: task, multiple: true}`。
- 两张表各自存着同一个业务编号（服务器的问题组号和问题组表的组号、任务编号和驳回记录里的来源任务），又不想手动维护 link：在两边的字段上声明同一个**同值关联**名，见下一节。
- 给已有表加子表：单独 apply 一个带 `parent` 的 spec，例如 `{name: task_tag, parent: task, fields: [...]}`。

## 同值关联（config.match）

值相同的记录在知识图谱里自动连边，不用写 link：

```yaml
tables:
  - name: ts_run
    children:
      - name: server
        fields:
          - {key: group_no, type: text, config: {match: group_no}, description: 所属问题组号，如 1.1}
      - name: problem_group
        fields:
          - {key: group_no, type: text, unique: true, config: {match: group_no}, description: 问题组号}
```

- 名字（`match` 的值）相同的字段互相比较，字段 key 可以不同；名字规则同字段 key。只有 `text` `number` `url` `email` 能声明。
- 只在**最近的公共父记录**下比较：上例只连同一个 `ts_run` 里的 server 和 problem_group，不同轮次的 `1.1` 不会连在一起。两张表没有公共父表时在整个域里比较。
- 同一个字段里值相同不连（两台 server 都在 1.1 组不算关联）。例外是 `self: true`，见下。
- 同一范围里一个值至少有一侧只有一条记录才连，多的一侧指向唯一的一侧；两侧都有多条（多对多）或一共超过 50 条时不连，`dt graph lint -D <域>` 的 `ambiguous` 会列出来。
- 边在查询时现算，加、改、去掉 `match` 都不改数据，也不是破坏性变更。

**同一个字段里的同值**：同一个实体在一张表里出现多次（同一台机器的 SN 出现在多次排查里），要把这几条记录连起来时，在字段上加 `self: true`：

```yaml
- {key: sn, type: text, config: {match: sn, self: true}, description: 服务器 SN}
```

- 这个字段里值相同的记录在**整个域**里比较（不受公共父记录限制），按 `_id` 顺序串成一条链：n 条记录只连 n-1 条边，后建的指向前一条，不两两全连。
- 一个值超过 50 条时不连，记进 `lint` 的 `ambiguous`（`reason: too_many`）。
- `self` 必须和 `match` 一起写；同名的其他字段仍按上面的规则和它比较。
- 只给「同一个值就是同一个实体」的字段加（SN、工单号）。组号、状态这类同值只表示同组的字段不要加。

怎么用好：

- 只给**标识实体的编号**声明：组号、工单号、SN、任务编号。状态、类型、负责人、日期、分数这类很多记录都会取到同一个值的字段不要声明，连出来的边没有意义，还会被多对多规则挡掉。
- 被指向的那一侧（实体表）的字段最好加 `unique: true`，保证每个值只有一条。
- 字段里是逗号分隔的多个值（如 `ms-a,ms-b`）时不支持，需要关联就拆成子表或改用 link。
- apply 之后跑一次 `dt graph lint -D <域>`，看 `ambiguous` 是否为空；不为空说明数据里有重复编号，或者这个字段不适合声明。

## 其他命令

```bash
dt table show task -D proj_a                 # 字段定义、子表概要、记录数、已归档字段
dt field add task priority -D proj_a -A claude --type single_select --options 高,中,低 --default 中 \
  --label 优先级 --description '高表示本周必须完成'
dt table drop task -D proj_a -A claude --force   # 删除表、所有子表和数据；不加 --force 只返回会删多少数据
```

## 注意

- 不要为了改名删字段再建字段，字段 key 定下后尽量不改；只改显示名用 `label`。
- 子表名不能和父表的字段 key 重名。
- link 不能跨域引用。
- 已有表的父表不能修改。
- 从 spec 删掉的字段只是归档，数据还在；在 spec 里写回同一个 key 就能恢复。
- spec 里漏掉的已有子表不会被删除，计划里会出现 `keep_child` 提示。
