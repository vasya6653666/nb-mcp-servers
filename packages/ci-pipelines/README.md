# @neuralbridge/ci-pipelines-mcp
MCP server for CI pipelines. It is the server behind the `nb-ci-pipelines` power of NeuralBridge IDE, and works with any
MCP client over stdio. It runs three open-source programs when they are installed: actionlint (GitHub Actions workflow
linter), act (runs GitHub Actions workflows locally in Docker) and glab (GitLab CLI). Each one is optional: tools of a
missing program answer with what to install.
## Tools
| Tool | What it does | Changes |
|---|---|---|
| `ci_detect` | Installed programs and versions; with `dir`, workflow files in `.github/workflows` and `.gitlab-ci.yml` with its `include` entries (listed, not expanded) | nothing |
| `ci_actionlint` | `actionlint -format '{{json .}}'` on the repository or on given files; one line per problem: `file:line:col: [kind] message` | nothing |
| `ci_gitlab_lint` | `glab ci lint [file]`; optional `--dry-run`, `--ref`, `--include-jobs` | nothing; **the file content is sent to the GitLab server of the repository** |
| `ci_act_list` | `act -l`: jobs, stages, workflows and events as a table | nothing |
| `ci_act_plan` | `act … -n` (dry run) for an event, job and workflow file; saves a plan with the arguments and sha256 of the workflow files, the event file and act's project files (`.actrc`, `.env`, `.vars`, `.input`) and returns its id | a plan record in the data folder |
| `ci_act_run` | Runs exactly the saved plan, once, after checking that none of the fingerprinted files changed | **runs the jobs in Docker containers on this machine** |
`ci_detect`, `ci_actionlint`, `ci_gitlab_lint` and `ci_act_list` are marked read-only. actionlint calls `shellcheck` and
`pyflakes` on `run:` scripts when they are installed (`externalLinters: false` turns this off); they only read the scripts.
`ci_gitlab_lint` is marked open-world because glab uploads the file to the GitLab server for validation. `ci_act_plan` is
not read-only: a dry run may fetch remote actions into act's cache. `ci_act_run` is destructive: the jobs run the project's
code with the plan's secrets, may pull container images, download actions and reach the network. A run is refused when a
fingerprinted file changed since the plan; the scripts and sources that the jobs use are taken from the working tree as it
is at run time. The run has a 60-minute limit and its output is cut to the last 20,000 characters.
## Secrets
`ci_act_plan` and `ci_act_run` never take secret values as arguments. Secrets reach act only through `secretFile`, an
absolute path of a `KEY=value` file the user names (act `--secret-file`); the server checks that the file exists and never
reads or prints it. Without `secretFile` the server passes an empty file, so act does not pick up a `.secrets` file from the
repository on its own. act replaces the values of secrets with `***` in its log (the server never passes
`--insecure-secrets`); on top of that the server masks passwords in URLs, `password=` / `token:`-style values, `Bearer`
tokens and GitHub/GitLab tokens by prefix in every answer. If the secret file has no `GITHUB_TOKEN`, act asks the `gh` CLI
for one when `gh` is installed and logged in.
## Run
```bash
npx -y @neuralbridge/ci-pipelines-mcp@1.0.0
```
Requires Node.js 20+ and any of the programs on `PATH`. To use a specific binary, set its variable:
| Program | Variable | Notes |
|---|---|---|
| actionlint | `NB_CI_ACTIONLINT` | 1.6 or newer (`-format` with `json`) |
| act | `NB_CI_ACT` | needs a running Docker daemon for `ci_act_run`; `--action-offline-mode` exists since 0.2.4x |
| glab | `NB_CI_GLAB` | needs `glab auth login` (or `GITLAB_TOKEN`) for the GitLab server; `--dry-run` / `--ref` need a recent glab |
act asks interactively for a default runner image on first use. Run `act` once in a terminal to choose one, or pass
`platforms` (`["ubuntu-latest=<image>"]`, act `-P`) to `ci_act_plan`. Programs run without a shell, with stdin closed,
`NO_COLOR=1`, `ACT_DISABLE_VERSION_CHECK=1` (no version notices request), and `GLAB_CHECK_UPDATE=false`,
`GLAB_SEND_TELEMETRY=0`, `GLAB_NO_PROMPT=1`. The server itself downloads and installs nothing.
Plans are kept in `$PLUGIN_DATA/plans` (the power's data folder) or, outside NeuralBridge IDE, in
`<system temp>/nb-ci-pipelines/plans`: the folder has mode 0700, records 0600, and unused plans are removed after 24 hours.
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests with fake actionlint, act and glab binaries
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
