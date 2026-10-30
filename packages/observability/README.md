# @neuralbridge/observability-mcp

Read-only MCP server for observability stacks. It queries tools the user already
runs, over their HTTP APIs, and never installs or changes anything:

- **Prometheus** — PromQL instant and range queries, firing/pending alerts.
- **Loki** — LogQL log queries.
- **Grafana** — search dashboards, fetch a dashboard by uid.
- **Alertmanager** — list alerts.

## Configuration

Each service is enabled by its URL in the environment. Authentication is optional
and provided per service as a bearer token or a username/password pair. Secrets
stay in the environment and are never printed in tool output.

| Service | URL | Auth (optional) |
|---|---|---|
| Prometheus | `PROMETHEUS_URL` | `PROMETHEUS_TOKEN` or `PROMETHEUS_USERNAME` + `PROMETHEUS_PASSWORD` |
| Loki | `LOKI_URL` | `LOKI_TOKEN` or `LOKI_USERNAME` + `LOKI_PASSWORD` |
| Grafana | `GRAFANA_URL` | `GRAFANA_TOKEN` or `GRAFANA_USERNAME` + `GRAFANA_PASSWORD` |
| Alertmanager | `ALERTMANAGER_URL` | `ALERTMANAGER_TOKEN` or `ALERTMANAGER_USERNAME` + `ALERTMANAGER_PASSWORD` |

`NB_OBS_TIMEOUT_MS` sets the per-request timeout in milliseconds (default 30000,
maximum 120000).

Use `obs_detect` to see which services are configured.

## Tools

All tools are read-only.

- `obs_detect`
- `obs_prometheus_query`, `obs_prometheus_range`, `obs_prometheus_alerts`
- `obs_loki_query`
- `obs_grafana_search`, `obs_grafana_dashboard`
- `obs_alertmanager_alerts`

## Build and test

```
npm install
npm run build
npm test
```
