# 查询语法

## where

```json
{
  "status": {"in": ["待办", "进行中"]},
  "due": {"lt": "2026-11-10"},
  "title": {"contains": "设计"},
  "$or": [{"priority": "高"}, {"_created_by": "claude"}]
}
```

- 多个条件之间是 AND。
- 直接写值等价于 `eq`：`{"status": "完成"}`。
- `$and`、`$or` 接条件数组，可以嵌套。
- 系统字段也能用：`{"_updated_at": {"gte": "2026-11-06"}}`、`{"_parent_id": 12}`。

## 关键词搜索 $search

```json
{"$search": "压测 p99"}
```

- 按空白拆词，每个词都要在这条记录的某个字段里出现（词之间是 AND）。
- 文本、长文本、链接、邮箱、人员、单选按子串找，不区分大小写；多选和附件看每个值（附件看路径）；数字字段要相等；`12` 或 `#12` 也匹配 `_id`。
- 可以和其他条件一起写：`{"$search": "压测", "status": "进行中"}`。

## 按子表筛父记录 $child

```json
{"$child": {"table": "task_log", "where": {"content": {"contains": "超时"}}}}
```

- 父记录下至少有一条子记录满足 `where` 就算命中；省略 `where` 表示「至少有一条子记录」。
- 子表的 `where` 里还能再写 `$child`，查多级子表。
- 连本表一起搜：`{"$or": [{"$search": "超时"}, {"$child": {"table": "task_log", "where": {"$search": "超时"}}}]}`。

## 日期和时间

查询值和写入值用同样的规则换算：datetime 字段和 `_created_at`、`_updated_at` 可以写带时区的 ISO 字符串、不带时区的本地时间或 Unix 时间戳（秒或毫秒），date 字段可以写 `"2026-11-06"` 或 `"2026/11/6"`。比较和排序都按换算后的时间，不用自己转格式：

```json
{"at": {"gte": "2026-11-06T10:00:00+08:00"}}
{"at": {"gte": 1793930400}}
```

## 相对日期

date、datetime 字段和 `_created_at`、`_updated_at` 上可以写 `$today`、`$week_start`（本周一）、`$month_start`，后面可以加天数偏移：

```json
{"due": {"lt": "$today"}}                                 // 已逾期
{"due": {"gte": "$today", "lt": "$today+7d"}}             // 未来 7 天到期
{"_updated_at": {"gte": "$today-6d"}}                     // 最近 7 天改过
```

按服务所在机器的本地日期换算。存进视图后每天自动往前走。

## 运算符

| 运算符 | 普通字段 | 数组字段（multi_select、多值 link、多值 attachment） |
|---|---|---|
| `eq` | 等于；值为 null 表示为空 | 包含给出的全部值 |
| `ne` | 不等于（空值也算不等于） | 不包含该值 |
| `gt` `gte` `lt` `lte` | 比较大小，日期按字符串比较 | 不支持 |
| `in` | 等于其中任意一个 | 包含其中任意一个 |
| `nin` | 不等于其中任何一个 | 不包含其中任何一个 |
| `contains` | 文本子串匹配，不区分大小写 | 包含给出的值（可以是数组，表示全部包含） |
| `is_null` | `true` 为空，`false` 不为空 | 同左 |

- 附件字段按路径匹配：`{"output": {"contains": "/abs/path/report.md"}}`。
- 下拉字段的查询值也会校验，写了不存在的选项会报错并给出可选值。
- checkbox 未设置时按 `false` 处理。

## sort / limit / offset

- `--sort -_updated_at,title`：逗号分隔，前缀 `-` 表示降序；最后总是按 `_id` 升序兜底。
- `--limit` 默认 100，最大 1000；`--offset` 翻页。返回里的 `total` 是满足条件的总数。

## include

`--include task_log,task_log.log_note,task_board`：用点号表示多级子表。one_to_many 子表输出为数组，one_to_one 子表输出为对象或 null。

## 返回结构

`dt rec query` 的 `data` 里是 `items` 和 `total`：

```json
{"ok": true, "domain": "proj_a", "data": {"items": [{"_id": 12, "...": "..."}], "total": 3}}
```

`dt graph related` 等图查询用的是 `data.records`，解析时不要混用。

`--format table` 可以按表格输出，比 JSON 更适合浏览。`dt rec query` 没有 `--fields`（只有 `dt graph related` 有）。
