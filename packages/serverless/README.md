# @neuralbridge/serverless-mcp

MCP server for serverless workloads through the Knative CLI (`kn`) and the OpenFaaS CLI (`faas-cli`). It is the server
behind the `nb-serverless` power of NeuralBridge IDE, and works with any MCP client over stdio. Both CLIs are optional:
the `kn_*` tools need `kn`, the `faas_*` tools need `faas-cli`.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `sls_detect` | Installed CLIs and versions; kubeconfig context and contexts for `kn`; gateway origin and saved login for `faas-cli` | nothing |
| `kn_service_list` | Knative services: name, URL, latest ready revision, Ready, age | nothing |
| `kn_service_describe` | One service: readiness, revisions, image, concurrency, autoscaling, traffic, conditions; environment by name only | nothing |
| `kn_revision_list` | Revisions, optionally of one service | nothing |
| `kn_deploy_plan` | `kn service create` / `update` with `--target` into a file: the declaration (YAML, env values masked) and the changes against the running service; saves a plan | a plan and a declaration file in the data folder |
| `kn_deploy_apply` | `kn service create --filename` of exactly the planned declaration (`--force` for an existing service), once | **the cluster** |
| `kn_delete_plan` | Shows the service that would be deleted; saves a plan with its uid | a plan file in the data folder |
| `kn_delete_apply` | `kn service delete --wait` of exactly the planned service, once | **the cluster** |
| `faas_list` | Functions on the gateway: name, image, replicas, invocations, age | nothing |
| `faas_describe` | One function: status, image, URL, environment names, secret names, labels, annotation keys, resources | nothing |
| `faas_logs` | Recent log lines of a function (`lines`, `since`; does not follow) | nothing |
| `faas_build` | `faas-cli build` of a stack file; `shrinkwrap` only writes build contexts | local images or `./build` |
| `faas_deploy_plan` | Per function of a stack file: create or update and what changes against the gateway; saves a plan | a plan file in the data folder |
| `faas_deploy_apply` | `faas-cli deploy` of exactly the planned stack file, filter and namespace, once | **the gateway** |
| `faas_remove_plan` | Which of the named functions exist and would be removed; saves a plan | a plan file in the data folder |
| `faas_remove_apply` | `faas-cli remove` of exactly the planned functions, once | **the gateway** |

Changes are made only in two steps. A plan tool shows what will happen and saves a plan record; the matching apply tool
(marked destructive) takes only the plan id, checks that the target is still the same and runs exactly the saved command,
then removes the plan. Plans expire after 24 hours.

- **Knative.** The plan lets `kn` itself build the service declaration: `kn service create` (new service) or
  `kn service update` on top of the current declaration (existing service) with `--target=<file>.json`, which writes the
  result to a file instead of the cluster. For an existing service only the given settings change. Before applying, the
  server checks that the kubeconfig context still points to the same cluster, user and namespace (sha256 of them, not the
  values), that the declaration file is unchanged (sha256), and that the service was not created, recreated (uid) or
  changed (generation) in between. Then `kn service create --filename` applies the file; with `--force` for an existing
  service, which replaces its spec with the declaration.
- **OpenFaaS.** The plan reads the stack file and its `environment_file` entries and compares each function with
  `faas-cli describe`. Before applying, the server checks the gateway, the sha256 of the stack file and environment files,
  and the state of every planned function on the gateway. `faas-cli deploy` is not given images to build: images must be
  in a registry the cluster can pull from.

Every `kn` command that talks to a cluster gets explicit `--context` and `--namespace`: the ones passed to the tool, or the
current context and its namespace at the time of the call.

## Environment variables of a Knative service

`kn_deploy_plan` never takes secret values. Literal `env` pairs are accepted only for non-secret settings: names that look
like secrets (`*PASSWORD*`, `*TOKEN*`, `*SECRET*`, `*KEY*`, `*CREDENTIAL*`, …) and values that look like credentials (URLs
with a password, private keys, JWTs, long random strings) are refused. A secret is put into a Kubernetes Secret by the user
and referenced by name: `envValueFrom` (one key, `kn --env-value-from NAME=secret:<name>:<key>`) or `envFrom` (all keys,
`kn --env-from secret:<name>`); ConfigMaps work the same way. Passing values from the server's own environment is not
supported on purpose: they would end up in plain text in the service spec and in the saved plan.

## Secrets in answers

Environment values of services and functions are never shown, only names (`NAME=***`); Secret and ConfigMap references are
shown by name and key. Annotation values of functions are not shown. Passwords in URLs (`user:***@`), `password=` /
`token:` pairs and bearer tokens are masked in logs, conditions and error messages. The OpenFaaS gateway is shown only as
an origin (`scheme://host:port`), never with credentials or a path; Kubernetes server addresses are not shown at all.
The server does not read kubeconfig credentials or the faas-cli token: it only checks whether a saved login exists for the
gateway. Logs go to stderr only.

## Run

```bash
npx -y @neuralbridge/serverless-mcp@1.0.0
```

Requires Node.js 20+. The server installs and downloads nothing; it runs only programs already installed on the machine.

| Variable | Meaning |
|---|---|
| `NB_SLS_KN` | Path of `kn`; default: `kn` on `PATH`. kn 1.0 or newer. |
| `NB_SLS_FAAS` | Path of `faas-cli`; default: `faas-cli` on `PATH`. faas-cli 0.18.9 or newer (for `--json` in `list` and `describe`); `faas_logs` and `faas_build` work with older versions. |
| `KUBECONFIG` | Kubeconfig files for `kn`, as usual; default `~/.kube/config`. |
| `OPENFAAS_URL` | OpenFaaS gateway. Default: `http://127.0.0.1:8080`, as faas-cli. A stack file whose `provider.gateway` points to another gateway is refused, because faas-cli would prefer the file. |
| `OPENFAAS_NS` | Default function namespace (faas-cli 0.18.13+). |
| `OPENFAAS_CONFIG` | Folder of the faas-cli config with the saved login; default `~/.openfaas`. |
| `PLUGIN_DATA` | Data folder for plans (mode 0700, files 0600); outside NeuralBridge IDE the system temp folder. |

Log in to the gateway yourself with `faas-cli login` before using the `faas_*` tools; the server never takes passwords.
Commands without a stack file run in an empty folder inside the data folder, so faas-cli does not pick up a `stack.yaml`
from an unrelated directory; commands with a stack file run in its directory, as faas-cli resolves handler and
`environment_file` paths from there.

What the CLIs themselves may download: `faas_build` builds images with the local container engine (it runs the
Dockerfile and build steps of the project and pulls base images) and downloads templates listed in the stack file that
are missing under `./template`, unless `noTemplatePull` is set (`--disable-stack-pull`). `kn` and the other `faas-cli`
commands only talk to the cluster or the gateway. Neither CLI has telemetry; faas-cli checks for updates only in
`faas-cli version` without `--short-version`, which this server does not call.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake kn and faas-cli binaries
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
