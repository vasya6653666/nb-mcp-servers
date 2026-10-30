# @neuralbridge/workflow-orchestration-mcp

MCP server for workflow engines through the Temporal CLI and the Argo Workflows CLI. It is the server behind the
`nb-workflow-orchestration` power of NeuralBridge IDE, and works with any MCP client over stdio. Both programs are
optional: the `temporal_*` tools need the Temporal CLI, the `argo_*` tools need the argo CLI.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `wfo_detect` | Which CLIs are available and their versions; the Temporal address, Namespace and config profile; the Argo Server address or the current kubeconfig context | nothing, no network |
| `temporal_workflow_list` | Workflow Executions matching a List Filter: status, Workflow ID, Run ID, type, task queue, age | nothing |
| `temporal_workflow_describe` | One execution: status, type, task queue, times, history size, pending activities with attempts and last failure, pending children, failure of a failed run | nothing |
| `temporal_workflow_history` | Event History as a short timeline: event type, time, activity, signal, timer, failure message; payload sizes only | nothing |
| `temporal_task_queue_describe` | Pollers (Workers) and backlog statistics of a task queue | nothing |
| `temporal_start_plan` | What would be started: type, Workflow ID, task queue, input, timeouts, target; saves a plan | a plan file in the data folder |
| `temporal_start_apply` | Starts exactly the planned Workflow, once | **runs Workflow code** |
| `temporal_signal_plan` | Checks the run is Running, pins its Run ID, shows Signal name and input; saves a plan | a plan file |
| `temporal_signal_apply` | Sends exactly the planned Signal to the pinned run, once | **the Workflow** |
| `temporal_stop_plan` | Cancel or terminate: current state and effect; pins the Run ID; saves a plan | a plan file |
| `temporal_stop_apply` | Cancels or terminates exactly the pinned run, once | **the Workflow** |
| `argo_list` | Workflows: name, status, age, duration, progress, message | nothing |
| `argo_get` | One workflow with every node: type, phase, template, duration, node id, error message; parameters and artifacts by name only | nothing |
| `argo_logs` | Last log lines of a workflow or one pod, secrets masked | nothing |
| `argo_lint` | `argo lint`, offline by default | nothing |
| `argo_submit_plan` | `argo submit --server-dry-run` of a file or of `--from kind/name`; names, entrypoint, service account, images; saves a plan | a plan file |
| `argo_submit_apply` | Submits exactly the planned source and parameters, once | **runs pods in the cluster** |
| `argo_stop_plan` | Stop (exit handlers run) or terminate (they do not): current state; saves a plan with the workflow uid | a plan file |
| `argo_stop_apply` | Stops or terminates exactly the planned workflow, once | **the cluster** |
| `argo_retry_plan` | A Failed or Error workflow: its failed nodes; saves a plan | a plan file |
| `argo_retry_apply` | Retries exactly the planned workflow, once | **runs pods in the cluster** |

Changes are made only in two steps. A plan tool shows what will happen and saves a plan record; the matching apply tool
(marked destructive) takes only the plan id. Before running, it checks that the target is the same (Temporal address,
Namespace and config profile; Argo Server address or kubeconfig context and namespace), that a Temporal run is still the
pinned Run ID and still Running, that an Argo workflow still has the same uid, phase and finish time, that a manifest
file has the same sha256, and that a template used with `--from` has the same `resourceVersion`. Then it runs exactly the
saved command and removes the plan. Plans expire after 24 hours. A Temporal start with a Workflow ID uses
`--fail-existing`, so it never attaches to an execution that is already running.

## Secrets and user data

Temporal payloads (Workflow and activity inputs, results, memo, search attribute values, heartbeat details) are never
shown: the server asks the CLI for raw payloads (`--no-json-shorthand-payloads`) and reports only their size. Argo
parameter and artifact values are not shown either, only their names. Passwords in URLs (`user:***@`), `password=` /
`token:` / `api_key=` pairs and bearer tokens are masked in logs, failure messages and error texts. The input of a planned
Temporal start or Signal is shown with such values masked, and sent unchanged.

Credentials stay where the programs read them. Temporal: `TEMPORAL_API_KEY`, `TEMPORAL_TLS_*` and the config profile
(`temporal.toml`); the server reads only the `address` and `namespace` properties of the profile and reports only
whether an API key or TLS settings are present in the environment. Argo: kubeconfig, or `ARGO_SERVER` with `ARGO_TOKEN`;
the Argo Server address is shown without user, password or path, and the token is never read. Saved plans contain the
inputs and parameters in plain text: the plans folder has mode 0700 and plan files 0600. Logs go to stderr only.

## Run

```bash
npx -y @neuralbridge/workflow-orchestration-mcp@1.0.0
```

Requires Node.js 20+. Programs are found on `PATH`, or set:

| Variable | Program |
|---|---|
| `NB_WFO_TEMPORAL` | Temporal CLI (`temporal`), 1.0 or newer; reading the config profile needs 1.4 or newer, older versions fall back to `temporal env` |
| `NB_WFO_ARGO` | Argo Workflows CLI (`argo`), 3.4 or newer |

The server installs and downloads nothing, and neither CLI downloads anything for these commands. Commands run without a
shell, with stdin closed, `NO_COLOR=1`, `--color=never` for Temporal and `--no-color` for `argo logs`. If
`TEMPORAL_CODEC_ENDPOINT` is set, the Temporal CLI sends payloads to that codec server to decode them.

Temporal target resolution follows the CLI: `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`, then the config profile
(`TEMPORAL_PROFILE`, `TEMPORAL_CONFIG_FILE`), then `localhost:7233` and `default`. Argo uses `ARGO_SERVER` when it is
set, otherwise the kubeconfig (`KUBECONFIG` or `~/.kube/config`); every kubeconfig command gets an explicit `--context`,
and a plan pins the context it was made with. The namespace comes from the tool argument, `ARGO_NAMESPACE` or the context.

Saved plans are kept in `$PLUGIN_DATA/plans` (the power's data folder) or, outside NeuralBridge IDE, in the system temp
folder.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake temporal and argo binaries
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
