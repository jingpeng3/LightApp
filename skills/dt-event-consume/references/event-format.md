# 事件格式与游标

## 三种记录事件

### insert

```json
{
  "seq": 1040,
  "op": "insert",
  "domain": "proj_a",
  "table": "task",
  "record_id": 31,
  "actor": "claude",
  "ts": "2026-11-06T08:00:00.000Z",
  "fields": {
    "title": {"before": null, "after": "写设计"},
    "status": {"before": null, "after": "待办"}
  },
  "record": {"_id": 31, "title": "写设计", "status": "待办"}
}
```

### update

```json
{
  "seq": 1042,
  "op": "update",
  "domain": "proj_a",
  "table": "task",
  "record_id": 31,
  "actor": "claude",
  "ts": "2026-11-06T08:01:00.000Z",
  "fields": {
    "status": {"before": "待办", "after": "完成"}
  },
  "record": {"_id": 31, "title": "写设计", "status": "完成"}
}
```

`fields` 只包含实际变化的用户字段，不包含 `_version`、`_updated_at` 等系统字段。

### delete

```json
{
  "seq": 1043,
  "op": "delete",
  "domain": "proj_a",
  "table": "task",
  "record_id": 31,
  "actor": "claude",
  "ts": "2026-11-06T08:02:00.000Z",
  "fields": {
    "title": {"before": "写设计", "after": null},
    "status": {"before": "完成", "after": null}
  },
  "record": {"_id": 31, "title": "写设计", "status": "完成"}
}
```

delete 的 `record` 是删除前的快照。

## 游标

`dt event list -D <域> --since <seq>` 返回：

```json
{
  "ok": true,
  "domain": "proj_a",
  "data": {
    "items": [ ...事件，按 seq 升序... ],
    "seq": 1043
  }
}
```

- `data.seq` 是**下一次请求的游标**。
- 如果一批没取满 `--limit`，它会推进到当前最大变更 seq；批内即使有被表/字段/op 过滤掉的事件也不会漏，因为下次从更大的 seq 继续。
- 处理成功后持久化 `data.seq`；失败时不要更新。

`dt event watch` 不输出游标字段，只输出事件行；用最后一条事件的 `seq` 作为游标。如果这一轮没有事件，保留旧游标。

## 筛选

```bash
--op insert,update       # 默认三种都返回
--table task             # 表名
--field status           # 只看实际变化了该字段的事件
--id 31                  # 记录 id
--since 1040             # seq 大于它
--limit 200              # 单次最多 1000
```

字段筛选走 `dt_change_fields` 索引。`--field` 可以单独使用（跨表找该字段变化），但通常会配合 `--table`。

## webhook / command 的批量投递

绑定动作和这里读的是同一份事件，但投递会合并：

- 同一事务、同一绑定的事件 → 一条投递，`event_count` 是条数。
- 调度时一次动作可能带 `batch` 条投递（默认 20），最多 4000 条事件。
- webhook body：

```json
{
  "binding": "notify-done",
  "delivery_ids": [12, 13],
  "event_count": 2,
  "events": [ ...事件... ]
}
```

只有一条时额外有 `delivery_id` 和 `event`。

- command 的 stdin 是 JSONL，每行一个事件；`DT_EVENT_COUNT` 是条数。
- write 在一个事务里按事件顺序逐条执行。

投递是 at-least-once，重试可能重复。消费方按 `delivery_ids` / `seq` 去重；`dt event deliveries -D <域> <绑定名>` 查看状态，`dt event retry` 重排 failed。
