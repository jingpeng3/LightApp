<div align="center">

# dt

**A dynamic table for agents**

Agents create tables and read/write data from the CLI; humans see the same data live in the browser.
Records themselves form a knowledge graph — no separate graph database required.

English · [简体中文](README.md)

[![CI](https://github.com/jingpeng3/LightApp/actions/workflows/ci.yml/badge.svg)](https://github.com/jingpeng3/LightApp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![CLI](https://img.shields.io/badge/CLI-dt-3B82F6)](src/dt/cli.py)

[Quick start](#quick-start) · [Features](#features) · [How it works](#how-it-works) · [CLI](#cli) · [Using with agents](#using-with-agents) · [Development](#development)

</div>

---

dt is a dynamic table that runs on your machine. It is not "yet another spreadsheet" — it answers a different question: **after an agent finishes its work, can the process, the results, and the relationships between them be seen by humans, reused by other agents, and queried?**

- **Agents define tables and write data themselves**: describe what to store in YAML; `dt table apply` diffs against the current schema and produces a change plan. Destructive changes require `--force`.
- **Humans and agents work on the same data**: same validation, same change history. The page highlights changes in real time and shows who made them.
- **Records grow into a knowledge graph**: parent-child relations and `link` fields are the edges. Query relations, find paths, inspect dependencies, replay history.
- **Data changes can trigger actions**: fire a webhook, run a local command, write back a record, or deliver an inbox message. Delivery is at-least-once with automatic retries.

For a full capability overview (including the TEAMS case study), see [docs/introduction.md](docs/introduction.md). For the data model and API design, see [docs/design.md](docs/design.md).

## Quick start

### 1. Prerequisites

| Dependency | Purpose | Install |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | Manage Python environments and install the `dt` command | `brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Python 3.11+ | Run the server and CLI | uv downloads it automatically if missing; or `uv python install 3.11` |
| Node.js 20.19+ | Build the browser UI | `brew install node`, or install from [nodejs.org](https://nodejs.org/) |

### 2. Clone and install

```bash
git clone https://github.com/jingpeng3/LightApp.git
cd LightApp
(cd web && npm ci && npm run build)   # builds the UI into src/dt/static
uv tool install .                     # installs the dt command
```

To try it without a global install, run `uv sync` and use `uv run dt ...` instead of `dt ...`.

> [!NOTE]
> The UI build output `src/dt/static/` is git-ignored but explicitly packaged into the wheel by hatch (see `artifacts` in `pyproject.toml`). Build the UI before running `uv tool install .`.

### 3. Start the server

```bash
dt serve                              # opens http://127.0.0.1:8654
```

The CLI starts the server in the background automatically when it is not running, so you usually do not need this step. The server listens on `127.0.0.1` only and logs to `$DT_HOME/server.log`.

### 4. Create a table

```bash
cat > task.yaml <<'YAML'
name: task
label: Task
description: Things to do
fields:
  - {key: title, label: Title, type: text, required: true}
  - {key: status, label: Status, type: single_select, options: [Todo, Doing, Done], default: Todo}
children:
  - name: task_log
    label: Task log
    fields:
      - {key: content, type: long_text, required: true}
YAML

dt domain create demo -A me --label Demo
dt table apply -D demo -A me -f task.yaml
dt rec insert task -D demo -A me --data '{"title":"Write the design","task_log":[{"content":"Started"}]}'
dt rec query task -D demo --where '{"status":"Todo"}' --include task_log
dt rec update task 1 -D demo -A me --set '{"status":"Done"}'   # 1 is the _id returned by query
```

Refresh the page to see the task and its child table. Every CLI write is highlighted within a second and labeled with its actor.

- `-D <domain>`: domain commands must specify it explicitly; dt never reads the domain from an environment variable.
- `-A <actor>`: write commands must specify it (or set `DT_ACTOR`). The page and change history use it to distinguish who changed what.

## Features

| | Feature | Description |
|---|---|---|
| 🧾 | **Declarative schemas** | Define domains, tables, and nested child tables in YAML. `table apply` diffs the spec against the current state; destructive changes need `--force`. |
| 🧠 | **Progressive disclosure** | Fetch structure in three layers — domain → table → field — each returning only what is needed. Agents do not need to know the schema up front. |
| 🔌 | **Agent-first CLI** | Every command returns JSON; errors carry `code` / `message` / `hint` so agents can correct themselves. |
| 🖥 | **Live UI** | Table and board views, inline cell editing, record drawer, attachment preview; CLI writes are highlighted in the page in real time. |
| ✍️ | **Human-agent collaboration** | Humans and agents share the same validation and change history. Optimistic locking prevents silent overwrites. |
| 🕸 | **Knowledge graph** | Records are nodes; parent-child relations and `link` fields are edges. The graph already exists wherever the data does. |
| 🧭 | **Graph queries** | Related records, paths between records, dangling/orphan/cycle checks, dependency readiness and topological order, hub ranking — exportable as Mermaid or Graphviz. |
| 🎞 | **History replay** | Drag a timeline to replay the graph at any `seq` and watch how it grew. |
| 🔔 | **Event bindings** | Field changes trigger webhooks, local commands, record writes, or inbox messages; deliveries have cursors and retry with backoff. |
| 📥 | **Inbox** | Messages that need human attention in one place, with unread filtering, mark-all-read, and links back to the source record. |
| 📦 | **Attachment references** | Attachment fields reference local paths instead of copying files; preview images, Markdown, code, and PDFs. |
| 🔁 | **Shared facts for multi-agent work** | A domain is a collaboration space. Every write carries an actor and a field-level diff; humans and all agents read the same data. |

## How it works

```mermaid
flowchart LR
    agent["🤖 Agent<br/>Skill + dt CLI"] -->|JSON over HTTP| api["dt serve<br/>validate · audit · push"]
    human["👤 Human<br/>browser"] <-->|HTTP edit / WebSocket| api
    api --> db[("SQLite<br/>records · changes · bindings")]
    api -->|on demand| graph["🕸 graph queries<br/>parent / link / dependency"]
    api -->|match bindings| hook["🔔 webhook / command<br/>write / inbox"]
    hook --> agent
```

| Path | Description |
|---|---|
| **Writes** | The CLI and the page both go through the server and never connect to the database directly. Every write is validated, recorded in `dt_changes`, and pushed to the page. |
| **Startup** | The CLI launches `dt serve` automatically when needed. The server listens on localhost only and has no authentication. |
| **Graph** | Nodes and edges are computed from existing records and changes — no separate graph store. Relation, path, and dependency queries run over the whole domain. |
| **Events** | Bindings are matched inside the write transaction; delivery is asynchronous and retryable. The `write` action does not re-trigger bindings, avoiding loops. |

## Repository layout

```text
src/dt/                 server and CLI (FastAPI, Typer, SQLite)
  db.py                 connections, schema, migrations
  schema.py             spec parsing, apply plans, execution
  fields.py             field validation and normalization (incl. attachments)
  query.py              query DSL compiled to SQL
  records.py            record CRUD, nested inserts, cascades, change log
  graph.py              nodes and edges, related/path/dependency/impact queries
  events.py             record events, binding matching, delivery and actions
  inbox.py              inbox messages
  server.py             HTTP API and page routes
  cli.py                Typer CLI
web/                    React frontend (Vite, Tailwind, TanStack Table)
  src/components/       table, drawer, graph, events, inbox UI
skills/                 agent skills
  dt-schema/            design and change table schemas
  dt-data/              read/write data, attach files
  dt-event-bind/        create and manage event bindings
  dt-event-consume/     consume event streams, read the inbox
tests/                  pytest suite
docs/                   capability overview and design docs
```

## CLI

The `dt` CLI is the engine used by the skills; you rarely need to type these commands by hand. Every command returns JSON. On failure the exit code is 1 and the error object includes an actionable `hint`.

| Group | Commands | Purpose |
|---|---|---|
| Server | `dt serve` | Start the local server (the CLI starts it automatically) |
| Domains | `dt domain list / show / create / apply / drop` | Manage a namespace of tables, including whole-domain specs |
| Schema | `dt table apply / list / show / drop`, `dt field add` | Create tables from specs, inspect fields, add fields |
| Records | `dt rec insert / get / query / update / attach / impact / delete` | CRUD, batch inserts, attachments, delete-impact preview |
| History | `dt history` | Query changes by table, record, or `seq` |
| Graph | `dt graph related / path / lint / ready / order / hubs` | Relations, paths, health checks, dependency readiness and ordering, hubs |
| Events | `dt event list / watch / bind / binds / update / unbind / deliveries / retry` | Inspect event streams, manage bindings, view deliveries and retry |
| Inbox | `dt inbox list / read / unread / read-all / delete` | Handle messages that need human attention |

```bash
dt graph related 12 --depth all --direction in --kinds link --format table
dt graph ready --field task.needs --done '{"status":"Done"}'
dt rec impact task 12                  # preview cascade, unlink, and blocked deletes
dt event bind -D demo notify-done --on update --table task --field status \
  --where '{"status":"Done"}' --action inbox --prompt 'Task ${record.title} is done'
```

`--data` / `--set` / `--where` accept inline JSON, `@file`, or `-` (stdin). See [docs/design.md](docs/design.md#8-cli) for the complete command reference.

## Using with agents

Copy the directories under `skills/` into your agent's skill directory, for example Claude Code:

```bash
cp -r skills/* ~/.claude/skills/
```

| Skill | Purpose |
|---|---|
| `dt-schema` | Design and change table schemas: DSL, field types, child-table relations, dry-run before apply |
| `dt-data` | CRUD, nested/batch inserts, attachments, self-correction from `error.hint` |
| `dt-event-bind` | Create and manage event bindings: conditions, actions, batching, safety confirmation |
| `dt-event-consume` | Consume event streams: cursor resumption, idempotency, retries, inbox reads |

The skills use **progressive disclosure**: `SKILL.md` stays short, and the full syntax lives under each skill's `references/` directory, loaded only when needed.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `DT_HOME` | `~/.dt` | Directory for the database and logs |
| `DT_PORT` | `8654` | Server port |
| `DT_ACTOR` | none | Fallback actor for writes; `-A` takes precedence |

The server listens on `127.0.0.1` only and has no authentication; it is intended for single-user local use. See [SECURITY.md](SECURITY.md) for the deployment boundary and risks.

## Development

```bash
uv sync                               # install Python dependencies
uv run pytest                         # run backend tests
uv run dt serve --port 8655           # start the backend (use DT_HOME=/tmp/dt-dev for isolation)
cd web && npm ci && npm run dev       # frontend dev server, /api proxied to 8654
cd web && npm run typecheck           # frontend type check
cd web && npm run build               # build the UI into src/dt/static
```

CI runs `pytest` on Python 3.11 / 3.12 / 3.13, the frontend type check and build, and verifies that the wheel contains the UI. Run the same checks before submitting; see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Known limitations

- **Single-user local use**: the server listens on `127.0.0.1` only and has no authentication. Any local process can read and write the data; do not expose it to a LAN or the public internet.
- **Attachments are path references**: files are not copied. If the original moves or is deleted, the UI marks it as missing or changed.
- **Event delivery is at-least-once**: consumers must deduplicate by `X-DT-Delivery` or event `seq`.
- **Graph snapshots are capped**: a single snapshot keeps at most 3000 nodes by default (up to 10000), keeping the most recently updated records when truncated. Related, path, lint, and dependency queries run over the whole domain and are not affected by this cap.
- **Links cannot cross domains**: v1 does not support cross-domain graphs, saved layouts, same-value links, or deleting links from the graph (edit the field in the record drawer instead).
- **`command` bindings execute local commands**: they run as the `dt serve` process identity. Only configure commands you trust.

## Contributing and license

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately per [SECURITY.md](SECURITY.md). See [CHANGELOG.md](CHANGELOG.md) for release history.

[MIT](LICENSE) © jingpeng3
