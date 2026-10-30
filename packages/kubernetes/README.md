# @neuralbridge/kubernetes-mcp

MCP server for Kubernetes clusters through `kubectl` and, optionally, Helm. It is the server behind the `nb-kubernetes`
power of NeuralBridge IDE, and works with any MCP client over stdio.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `k8s_detect` | kubectl and Helm versions, kubeconfig location, current context and the list of contexts | nothing |
| `k8s_get` | Objects of a resource type as a short table: name, namespace, state, age; Secrets show only key names | nothing |
| `k8s_describe` | `kubectl describe` of one object or of a label selector | nothing |
| `k8s_logs` | Last lines of a container log (`tail`, `since`, `container`, `previous`) | nothing |
| `k8s_events` | Events of a namespace or of one object, oldest first | nothing |
| `k8s_diff_plan` | `kubectl diff` of manifest files, directories or a kustomization; saves a plan and returns its id | a plan file in the data folder |
| `k8s_apply_plan` | `kubectl apply` of exactly the planned manifests, once | **the cluster** |
| `k8s_delete_plan` | Lists exactly which objects would be deleted; saves a plan with their uids | a plan file in the data folder |
| `k8s_delete_apply` | Deletes exactly the planned objects, once | **the cluster** |
| `helm_list` | Helm releases with revision, status, chart and app version | nothing |
| `helm_status` | State and notes of a release, without its values | nothing |
| `helm_template` | Renders a local chart without contacting a cluster | nothing |
| `helm_lint` | `helm lint` of a local chart | nothing |
| `helm_upgrade_plan` | `helm upgrade --install --dry-run=server`: objects to add, change and remove; saves a plan | a plan file in the data folder |
| `helm_upgrade_apply` | Runs exactly the planned upgrade, once | **the cluster** |

Every command that talks to a cluster gets an explicit `--context` (`--kube-context` for Helm): the one passed to the tool
or the current context at the time of the call. The answer always names the context it used.

Changes to the cluster are made only in two steps. A plan tool shows what will happen and saves a plan record; the
matching apply tool (marked destructive) takes only the plan id. Before running, it checks that the context still points
to the same cluster, user and namespace, that no manifest, chart or values file changed (sha256 of every file; for
kustomize also the rendered output), that the objects to delete were not recreated (uids), and that the Helm release is
still at the planned revision. Then it runs exactly the saved command and removes the plan. Plans expire after 24 hours.
`kubectl apply` runs without `--prune`: removing a manifest does not delete its object.

## Secrets

Secret values are never shown. `k8s_get` lists only key names of Secrets; `kubectl describe` output, diffs and rendered
manifests have `data`, `stringData` and the last-applied annotation of Secrets replaced with `***`, and container
environment values masked. Passwords in URLs (`user:***@`), `password=` / `token:` pairs and bearer tokens are masked in
logs, events and error messages. Credentials stay in your kubeconfig: the server reads only what `kubectl config view`
prints (it hides certificate data and tokens itself), and server addresses are not shown. Logs go to stderr only.

## Run

```bash
npx -y @neuralbridge/kubernetes-mcp@1.0.0
```

Requires Node.js 20+ and `kubectl` on `PATH`; set `NB_K8S_KUBECTL` to use a specific binary. Helm is optional: the `helm_*`
tools need Helm 3.13 or newer (for `--dry-run=server`; Helm 4 works too), found on `PATH` or through `NB_K8S_HELM`. The
server installs and downloads nothing. kubectl itself fetches remote bases referenced by a kustomization, and
`kubectl diff` needs a `diff` program on `PATH` (on Windows, for example the one shipped with Git). Charts must be local
directories or `.tgz` files with dependencies already in `charts/`.

The kubeconfig is the standard one: `KUBECONFIG` or `~/.kube/config`. The server runs kubectl with `KUBERC=off` (user
preferences from kubectl 1.33+ do not change commands) and without `KUBECTL_EXTERNAL_DIFF`, so the diff is always unified.
Saved plans are kept in `$PLUGIN_DATA/plans` (the power's data folder) or, outside NeuralBridge IDE, in the system temp
folder; the folder has mode 0700 and plan files 0600.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake kubectl and helm binaries
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
