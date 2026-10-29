# @neuralbridge/infra-as-code-mcp

MCP server for Terraform and OpenTofu projects. It is the server behind the `nb-infra-as-code` power of NeuralBridge IDE,
and works with any MCP client over stdio.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `iac_detect` | Which binary (`terraform` or `tofu`) and version is used; with `dir`, lists directories with `.tf` files | nothing |
| `iac_fmt` | Checks formatting and shows the diff; with `write: true`, rewrites the files | local files with `write` |
| `iac_validate` | `init -backend=false` + `validate`; errors and warnings with file and line | local `.terraform` cache and `.terraform.lock.hcl` (downloads are listed in the answer) |
| `iac_plan` | `init` + `plan` with your backend and credentials; summary of resources to add, change, replace, destroy; saves the plan and returns its id | local `.terraform` cache and `.terraform.lock.hcl`; nothing in the infrastructure |
| `iac_apply_plan` | Applies exactly the saved plan, once | **real infrastructure** |

Only `iac_detect` is marked read-only. `iac_validate` and `iac_plan` run `init`, which downloads and runs provider plugins,
and `plan` also runs data sources of the project, so clients should ask before them; `iac_apply_plan` is marked destructive.
The summary lists deletions and replacements first and never contains attribute values. Saved plans contain variable and
attribute values in plain text: the plans folder is created with mode 0700, plan files with 0600, and unapplied plans are
removed after 24 hours.

## Run

```bash
npx -y @neuralbridge/infra-as-code-mcp@1.0.0
```

Requires Node.js 20+ and Terraform or OpenTofu on `PATH`. To use a specific binary, set `NB_IAC_BINARY` to its path.
Saved plans are kept in `$PLUGIN_DATA/plans` (the power's data folder) or, outside NeuralBridge IDE, in the system temp
folder. Credentials come from the environment the client starts the server with, as for any Terraform run.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with a fake terraform binary
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
