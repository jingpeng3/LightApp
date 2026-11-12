# 字段参考

## 通用属性

| 属性 | 说明 |
|---|---|
| `key` | 必填，小写字母开头，只含小写字母、数字、下划线 |
| `type` | 必填，见下表 |
| `label` | 显示名 |
| `description` | 字段含义、取值规则、单位或格式。读数据的 agent 靠它理解字段，有歧义的字段都要写 |
| `required` | 必填。插入时必须有值，更新时不能清空 |
| `unique` | 值唯一。不支持 checkbox、multi_select、多值 link、attachment、auto_number |
| `default` | 插入时没传该字段就用默认值；新增带默认值的字段时，已有记录也会补上。auto_number、link、attachment 不支持 |

## 类型

| type | 写入值 | 配置 |
|---|---|---|
| `text` / `long_text` | 字符串 | text 可设 `config: {match: 名字}`（同值关联） |
| `number` | 数字，或 `"3.5"` 这样的字符串 | 可设 `config: {match: 名字}` |
| `date` | `"2026-11-06"` | |
| `datetime` | ISO 8601，如 `"2026-11-06T10:00:00+08:00"`，带时区的统一存成 UTC | |
| `checkbox` | `true` / `false` | |
| `single_select` | 一个选项值 | `options` 必填 |
| `multi_select` | 选项值数组，传单个字符串会自动包成数组 | `options` 必填 |
| `url` | `http://` 或 `https://` 开头 | 可设 `config: {match: 名字}` |
| `email` | 邮箱 | 可设 `config: {match: 名字}` |
| `person` | 人名或 agent 名 | |
| `auto_number` | 只读，插入时从 1 开始递增；新增该字段时给已有记录补编号 | |
| `link` | 记录 `_id`，或 `_id` 数组 | `config: {table: 目标表, multiple: false}` |
| `attachment` | 绝对路径（文件或目录），或路径数组 | `config: {multiple: false, accept: [.md, .png]}` |

## options

```yaml
options: [待办, 进行中]                                  # 简写
options: [{value: 待办, color: gray}, {value: 进行中, color: blue}]
```

颜色：`blue green yellow orange red purple pink cyan gray`。不写颜色时，已有选项沿用原来的颜色，新选项按顺序分配。

## config.match（同值关联）

`text` `number` `url` `email` 字段可以写 `config: {match: 名字}`。声明了同一个名字的不同字段，值相同（文本去掉首尾空白，`8080` 和 `"8080"` 相同）的记录在图谱里连一条 `match` 边。规则：

- 只在两张表最近的公共父记录下比较；没有公共父表时在整个域里比较。
- 同一个字段内的同值不连；字段写了 `self: true`（`config: {match: sn, self: true}`）时例外：这个字段里同值的记录在整个域里按 `_id` 顺序串成链（n 条 n-1 条边，后建的指向前一条），超过 50 条不连。
- 同一范围里同一个值：一侧一条、另一侧多条时，多的一侧各连一条边指向唯一的那条；两侧都是一条时连一条；两侧都有多条，或一共超过 50 条时不连，记进 `dt graph lint` 的 `ambiguous`（`reason` 为 `many_to_many` 或 `too_many`）。
- 逗号分隔的多值文本按整个字符串比较，不拆分。

增删改 `match`、`self` 只影响图谱，不改数据，不算破坏性变更。

## 变更规则

| 变更 | 是否破坏性（需要 --force） |
|---|---|
| 新建表、新增字段、改 label / description / default / required / unique、新增选项、改颜色、调整顺序 | 否 |
| 删除字段（归档，数据保留） | 是 |
| 删除选项（使用该选项的值被清空） | 是 |
| 修改字段类型（能转换的值保留，不能转换的清空） | 是 |
| 多值改单值（只保留第一个） | 是 |
| link 改引用表（已有值清空） | 是 |
| 改子表的 relation / on_delete | 是 |
| 改已有表的父表 | 不允许 |

设 `unique: true` 时如果已有重复值，apply 会失败，整个计划不生效。
