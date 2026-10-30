# @neuralbridge/security-scanning-mcp
MCP server for local security scans with open-source scanners the user already has installed: Trivy (vulnerable
dependencies, misconfigurations, secrets, licenses, container images), Semgrep (code patterns) and Gitleaks (leaked
secrets in files and git history). It is the server behind the `nb-security-scanning` power of NeuralBridge IDE, and works
with any MCP client over stdio.
## Tools
| Tool | What it does | Writes / network |
|---|---|---|
| `sec_detect` | Which scanners are installed, with versions | nothing |
| `sec_trivy_fs` | `trivy fs` on a directory: `vuln`, `misconfig`, `secret`, `license` (default: the first three); severity filter, `ignoreUnfixed`, `offline` | Trivy cache (vulnerability DB, Java index, checks bundle are downloaded on first use and when outdated; the answer starts with what was downloaded) |
| `sec_trivy_image` | `trivy image` on an image reference (default scanners: `vuln`, `secret`); `localOnly` uses only Docker, containerd or Podman images | Trivy cache; pulls the image from its registry unless it is local or `localOnly` is set |
| `sec_semgrep` | `semgrep scan --json --metrics=off` with local rules, registry rulesets (`p/…`, `r/…`, `s/…`) or `https://` URLs; without `configs`, the project's `.semgrep.yml` / `.semgrep.yaml` / `.semgrep/` | `~/.semgrep` (settings, logs); registry rules and URLs are downloaded, and the answer says so |
| `sec_gitleaks` | `gitleaks dir` (current files) or `gitleaks git` (full history), `--redact`, JSON report | only a temporary report in the data folder, deleted right after reading |
Only `sec_detect` and `sec_gitleaks` are marked read-only. No tool changes project files, so there are no plan/apply
pairs. Scanners run with the project directory as the working directory, so project files such as `.trivyignore`,
`trivy.yaml`, `.semgrepignore`, `.gitleaks.toml` and `.gitleaksignore` are honoured.
`--config auto` of Semgrep is refused: it only works with metrics turned on, and this server always passes
`--metrics=off`.
## Secrets
Secret values are never returned: the server drops Trivy's `Match` and `Code`, Semgrep's matched lines (`extra.lines`)
and metavariable values, and Gitleaks' `Secret`, `Match` and `Line`, and prints only file, line, rule and, for git
history, commit, author and date. Semgrep matched code is dropped for every rule, not only for rules tagged as secrets:
hard-coded credentials are often reported by generic rules, and the model can open the file at the line itself. Free
text that is printed (rule messages, titles, stderr) is additionally masked: passwords in URLs (`user:***@`),
`password=` / `token:` / `api_key` style values, `Bearer` tokens and PEM private keys.
Scanner reports are written to `$PLUGIN_DATA/reports` (the power's data folder) or, outside NeuralBridge IDE, to
`<system temp>/nb-security-scanning/reports`: the folder has mode 0700, report files 0600, each report is deleted right
after it is read, and leftovers older than one hour are removed.
## Run
```bash
npx -y @neuralbridge/security-scanning-mcp@1.0.0
```
Requires Node.js 20+ and any of the scanners on `PATH`; each one is optional. To use a specific binary, set:
| Scanner | Variable | Minimum version |
|---|---|---|
| Trivy | `NB_SEC_TRIVY` | 0.51 (`--skip-check-update` for offline misconfig scans; older versions work without `offline`) |
| Semgrep | `NB_SEC_SEMGREP` | 1.x with the `scan` subcommand |
| Gitleaks | `NB_SEC_GITLEAKS` | 8.x; `dir` / `git` subcommands are used from 8.19.0, older 8.x get `detect --source … [--no-git]` |
The server never installs or downloads scanners. Telemetry and update checks of the scanners are turned off through
their environment variables (`TRIVY_DISABLE_TELEMETRY`, `TRIVY_SKIP_VERSION_CHECK`, `SEMGREP_SEND_METRICS=off`,
`SEMGREP_ENABLE_VERSION_CHECK=0`). Registry credentials for `trivy image` come from the environment the client starts the
server with and from the usual Docker configuration.
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests with fake trivy, semgrep and gitleaks binaries
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
