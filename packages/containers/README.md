# @neuralbridge/containers-mcp
MCP server for Docker and Podman. It is the server behind the `nb-containers` power of NeuralBridge IDE, and works with
any MCP client over stdio.
## Tools
| Tool | What it does | Changes |
|---|---|---|
| `ctr_detect` | Engine (`docker` or `podman`), client and server versions, whether the daemon is reachable, which Compose is used | nothing |
| `ctr_ps` | Containers as a table: name, image, status, ports, id; optional filters | nothing |
| `ctr_images` | Local images: tag, id, size, creation time | nothing |
| `ctr_logs` | Last log lines with `--tail`, `--since`, `--timestamps`; secret-like values masked | nothing |
| `ctr_inspect` | Short summary of a container or image; environment values and secret-like labels hidden | nothing |
| `ctr_compose_config` | Validates Compose files and shows the resolved model; `environment` values and `secrets` hidden | nothing |
| `ctr_build` | Builds an image from a context directory (`-f`, `-t`, `--target`, `--platform`, build args); never pushes | local image store; runs `RUN` steps of the Dockerfile and may pull base images |
| `ctr_compose_plan` | What `compose up -d` or `compose down` would create, recreate, rebuild, start, keep, remove or delete; saves the plan | nothing |
| `ctr_compose_apply` | Runs exactly the saved Compose command, once | **real containers, networks, volumes** |
| `ctr_remove_plan` | Which containers (`rm`) and images (`rmi`) would be removed; saves the plan | nothing |
| `ctr_remove_apply` | Removes exactly the planned objects, once | **real containers and images** |
Read and plan tools are marked read-only. `ctr_build` is not read-only (it runs project code and writes to the image
store) but not destructive. Both apply tools are marked destructive and accept only a plan id.

Plans: `ctr_compose_plan` records the project directory, the Compose files and `.env` with their sha256, a hash of the
resolved configuration and the exact command. `ctr_compose_apply` refuses to run if any of them changed, if the plan
was made for another directory or with another Compose binary, or if the plan was already used. `ctr_remove_plan`
records object ids; `ctr_remove_apply` refuses if a name now points to another object or a container was started after
planning without `force`. Running containers are removed only with `force`; images used by containers outside the
plan are refused. Nothing is ever pruned. Plans are kept in `$PLUGIN_DATA/plans` (mode 0700, files 0600) and expire
after 24 hours.

Output never contains values of container environment variables, of `environment` and `secrets` in Compose files,
passwords in URLs, or values of keys that look like passwords, tokens, secrets or keys. Long output is truncated.
## Run
```bash
npx -y @neuralbridge/containers-mcp@1.0.0
```
Requires Node.js 20+ and Docker or Podman already installed; the server installs and downloads nothing itself.

| Variable | Meaning |
|---|---|
| `NB_CONTAINERS_ENGINE` | Path of the engine binary. Default: `docker` on `PATH`, then `podman` |
| `NB_CONTAINERS_COMPOSE` | Path of a standalone Compose binary. Default: the engine's `compose` plugin, then `docker-compose` |
| `PLUGIN_DATA` | Folder for plans and temporary files. Default: `nb-containers` in the system temp folder |
| `DOCKER_HOST`, `DOCKER_CONTEXT`, `CONTAINER_HOST`, … | Passed to the engine unchanged, as for any CLI run |

Compose plans and `ctr_compose_config` need Compose v2 (`config --format json`, `ps --format json`). Compose 2.21+
prints `ps` as one JSON object per line, older v2 versions as an array; both are read. If `config --hash` is not
supported, the plan cannot tell changed services from unchanged ones and notes that running services are recreated if
their configuration or image changed. `pull: false` uses `up --pull=never`
(Compose 2.22 or newer). With Podman, `podman compose` runs an external provider; plans need it to be Docker Compose v2.
Commands run without a shell, with time limits (reads 1 minute, `build` 30 minutes, `compose up`/`down` 15 minutes),
closed stdin, and `NO_COLOR`, `DOCKER_CLI_HINTS=false`, `COMPOSE_MENU=false`, `PODMAN_COMPOSE_WARNING_LOGS=false`.
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests with a fake docker binary
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
