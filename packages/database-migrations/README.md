# @neuralbridge/database-migrations-mcp

MCP server for database schema migrations with Flyway, Liquibase and Atlas (versioned migrations). It is the server behind
the `nb-database-migrations` power of NeuralBridge IDE, and works with any MCP client over stdio.

## Tools

Every tool except `dbm_detect` takes `tool` (`flyway`, `liquibase` or `atlas`) and `dir`: the absolute path of the
migrations project folder, where `flyway.toml` / `flyway.conf`, `liquibase.properties` or `atlas.hcl` lives. Optional
`env` selects a Flyway TOML environment (`-environment`) or an `env` block of `atlas.hcl` (`--env`); `configFile` points to
another config file.

| Tool | What it does | Changes |
|---|---|---|
| `dbm_detect` | Installed tools and versions; with `dir`, config files, migration folders and changelog files | nothing |
| `dbm_status` | Applied and pending migrations as a table (version, description, state, date): `flyway info`, `liquibase status --verbose` + `history`, `atlas migrate status` | nothing in the schema (reads the database); the tool may run project callbacks, see below |
| `dbm_validate` | `flyway validate`, `liquibase validate`, `atlas migrate validate` (atlas.sum, no database) | nothing in the schema; the tool may run project callbacks, see below |
| `dbm_lint` | Atlas only: `migrate validate --dev-url` and `migrate lint --dev-url --latest N` on a dev database | the **dev** database only |
| `dbm_plan` | What will be applied: Flyway pending files and their SQL, Liquibase `update-sql` / `update-count-sql` / `update-to-tag-sql`, Atlas `migrate apply --dry-run`; warns about `DROP`, `TRUNCATE`, `ALTER TABLE … DROP`, `DELETE` / `UPDATE` without `WHERE`; saves the plan and returns its id | a plan file in the data folder |
| `dbm_apply_plan` | Applies exactly the saved plan, once: `flyway migrate -target=<last planned version>`, `liquibase update` / `update-count` / `update-to-tag`, `atlas migrate apply <number of planned files>` | **the real database** |

Only `dbm_detect` is marked read-only. `dbm_status`, `dbm_validate` and `dbm_plan` apply no migrations, but Flyway runs the
project's SQL and Java callbacks for `info` and `validate` (`beforeInfo.sql`, `afterValidate.sql` … in `locations`,
classes from `jarDirs`) and Liquibase instantiates `customChange` classes while parsing the changelog; such code can write
to the database, so these tools are not marked read-only. `dbm_apply_plan` is marked destructive. Before applying,
the server checks that the project files and config (sha256), the database URL and the list of pending migrations are the
same as when the plan was made, and refuses otherwise. A plan id works once and expires after 24 hours.

The dangerous-statement check is a text search, not an SQL parser. Flyway Java migrations and scripts that are not `.sql`
files are listed but their contents are not shown.

**Not supported on purpose:** `flyway clean` (drops every object in the schemas), `flyway undo`, `liquibase rollback*`,
`atlas migrate down`, `repair`, `baseline`, `drop-all`. They destroy data or rewrite migration history and should be run
by a person who knows the database, outside of an assistant.

## Database URL and secrets

A database URL usually contains a password, so tools never accept it as a value. Pass `urlEnv`: the **name** of an
environment variable that holds the URL (for example `APP_DB_URL`) in the environment the server is started with. Without
`urlEnv`, the URL from the project configuration is used (`flyway.toml`, `liquibase.properties`, `atlas.hcl`, which may
read it from the environment themselves).

- Flyway gets the URL as `FLYWAY_URL` (and `environments_<env>_url` when `env` is set), Liquibase as
  `LIQUIBASE_COMMAND_URL`; it does not appear on the command line.
- Atlas accepts the URL only as `--url`, so it is visible in the process list of the local machine for the duration of the
  command. Prefer `url = getenv("…")` in `atlas.hcl` with `env` if that matters.
- In every answer, passwords are masked: `user:***@` in URLs, `user/***@` in Oracle JDBC URLs, `password=***`,
  `-password=***`, and the literal values of the named variables and of variables whose names contain `PASSWORD`,
  `SECRET` or `TOKEN`. Plans store only the variable name and a salted hash of the URL.
- Plans and temporary SQL files are kept in `$PLUGIN_DATA` (the power's data folder) or, outside NeuralBridge IDE, in
  `<temp>/nb-database-migrations`; folders are created with mode 0700, files with 0600. The server writes nothing to stdout
  except the protocol and no secrets to its log.

`dbm_lint` takes `devUrlEnv`: the name of a variable with the URL of an **empty scratch** database. Atlas creates and drops
objects there. A `docker://…` dev URL makes Atlas start a container and may pull its image.

## Run

```bash
npx -y @neuralbridge/database-migrations-mcp@1.0.0
```

Requires Node.js 20+ and at least one of the tools, installed by you; the server installs and downloads nothing.

| Tool | On `PATH` as | Override | Notes |
|---|---|---|---|
| Flyway | `flyway` | `NB_DBM_FLYWAY` | Flyway 9 or newer (JSON output with `-outputType=json`); `env` (TOML environments) needs Flyway 10+. Telemetry is turned off with `REDGATE_DISABLE_TELEMETRY`. |
| Liquibase | `liquibase` | `NB_DBM_LIQUIBASE` | Liquibase 4.x or newer (kebab-case commands such as `update-sql`). Analytics and the banner are turned off (`LIQUIBASE_ANALYTICS_ENABLED=false`, `LIQUIBASE_SHOW_BANNER=false`). |
| Atlas | `atlas` | `NB_DBM_ATLAS` | Open-source or standard build. `migrate lint` is missing from the open-source build; `dbm_lint` then skips it with a note. The update check is turned off (`ATLAS_NO_UPDATE_NOTIFIER`). |

Flyway and Liquibase load the JDBC drivers and extensions configured by the project, the same way they do when run by hand.

On Windows, Flyway and Liquibase are started by `.cmd` / `.bat` launchers. Batch files cannot be started without a shell,
and this server never uses one, so on Windows run the server under WSL or point the override variable to a native
executable.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake flyway, liquibase and atlas programs
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
