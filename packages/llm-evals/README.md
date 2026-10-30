# @neuralbridge/llm-evals-mcp
MCP server for [promptfoo](https://www.promptfoo.dev/) evaluations. It is the server behind the `nb-llm-evals` power of
NeuralBridge IDE, and works with any MCP client over stdio.
## Tools
| Tool | What it does | Changes |
|---|---|---|
| `eval_detect` | Installed promptfoo version; with `dir`, lists `promptfooconfig.*` files under it | nothing |
| `eval_validate` | `promptfoo validate -c <config>`: schema of the config and of the test suite | nothing, but promptfoo loads providers and test files of the config, which can run JavaScript or Python from the project |
| `eval_plan` | Reads the config without running promptfoo and counts model calls (prompts × providers × tests × repeat, after filters); lists providers and tests; records sha256 of the config and of every file it refers to; returns a plan id | a plan file in the data folder |
| `eval_run` | Runs `promptfoo eval` exactly as planned, once, if no file changed; summary with totals, pass rate per provider, tokens and cost if reported, first 20 failures, eval id | **calls the models of the configured providers: costs money and sends prompts and test data to them**; adds the eval to the local promptfoo history |
| `eval_list` | Recent evals from the local history (`promptfoo list evals`) | nothing |
| `eval_show` | Summary of one eval (`promptfoo export eval <id>`) | nothing (the export is parsed and deleted) |
`eval_detect`, `eval_plan`, `eval_list` and `eval_show` are marked read-only; `eval_run` is marked destructive and open-world.
`eval_plan` counts calls for YAML and JSON configs with prompts, providers and tests given inline or in `.txt`, `.json`,
`.jsonl`, `.yaml`, `.csv` files and `*` patterns, with variable arrays, scenarios and the `filterPattern` / `filterFirstN` /
`repeat` filters. When the count depends on code (a JavaScript/TypeScript config, test generators in `.js` / `.py`, tests
from a URL) or a referenced file is missing, it says so and the run uses the config as is. Model-graded assertions
(`llm-rubric`, `factuality`, `similar` and others) add grader calls, which the plan reports separately. Responses cached by
earlier runs are reused unless `noCache` is set, so the real number of calls can be lower.
## Run
```bash
npx -y @neuralbridge/llm-evals-mcp@1.0.0
```
Requires Node.js 20+ and an installed promptfoo **0.119.0 or newer** (`eval_validate` works from 0.114.0, `eval_list` from
0.96.0): `npm install -g promptfoo` or `brew install promptfoo`. The server never downloads promptfoo and never runs it
through `npx`. It looks for `promptfoo` on `PATH` (on Windows, the npm wrapper `promptfoo.cmd` is resolved to its main
`.js` file and run with Node.js, without a shell). To use a specific installation, set `NB_EVAL_PROMPTFOO` to the path of
the executable or of its main `.js` file.
Every run of promptfoo gets `PROMPTFOO_DISABLE_TELEMETRY=1`, `PROMPTFOO_DISABLE_UPDATE=1`,
`PROMPTFOO_DISABLE_SHARING=true`, `PROMPTFOO_DISABLE_REMOTE_GENERATION=true` and `NO_COLOR=1`; `eval` also gets
`--no-share`, `--no-progress-bar` and `--no-table`. The server never calls `share`, `auth` or `redteam`.
Provider API keys come only from the environment the client starts the server with, and from the `.env` file promptfoo
reads in the config directory. promptfoo keeps its history and cache in `PROMPTFOO_CONFIG_DIR` (default `~/.promptfoo`).
Plans, run results (`runs/<plan id>.json`) and temporary exports are kept in `$PLUGIN_DATA` (the power's data folder) or,
outside NeuralBridge IDE, in `<system temp>/nb-llm-evals`: folders with mode 0700, files 0600, removed after 24 hours.
Result files contain prompts, variables and model outputs. Answers mask `sk-…` keys, `Bearer` tokens, `api_key=` pairs,
passwords in URLs and variables with secret-like names.
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests with a fake promptfoo binary
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
