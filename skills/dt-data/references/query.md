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
