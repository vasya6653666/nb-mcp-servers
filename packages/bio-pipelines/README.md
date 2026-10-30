# @neuralbridge/bio-pipelines-mcp

MCP server for bioinformatics pipelines written for Nextflow, WDL (run with miniwdl) and Snakemake. It is the server
behind the `nb-bio-pipelines` power of NeuralBridge IDE, and works with any MCP client over stdio.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `bio_detect` | Which of `nextflow`, `miniwdl`, `snakemake` are installed and their versions; with `dir`, lists `main.nf`, `nextflow.config`, `.wdl` files and Snakefiles | nothing |
| `bio_lint` | `nextflow lint -o json`, `miniwdl check`, `snakemake --lint json`; findings as `file:line:column: message` | nothing (Snakemake evaluates the Snakefile) |
| `bio_plan` | Dry run: Nextflow `run -preview -with-dag` (processes of the DAG), Snakemake `--dry-run` (jobs per rule), miniwdl `check` + required inputs + `run --json`; saves the exact command and file hashes as a plan | tool metadata (`.nextflow`, `.snakemake`) in the launch directory |
| `bio_run` | Starts exactly the planned command in the background, once, and returns a run id | **runs the pipeline**: computes, writes results, may overwrite outputs |
| `bio_run_status` | Running or finished, exit code, duration, progress, last 100 lines of the log | nothing |
| `bio_run_stop_plan` | Shows what is running and for how long; saves a stop plan | a plan file in the data folder |
| `bio_run_stop_apply` | Sends SIGTERM to the planned run, once | **stops the run** |
| `bio_runs` | Runs started through this server, newest first | nothing |

Read-only are only `bio_detect`, `bio_run_status` and `bio_runs`. `bio_lint` is not marked read-only because
`snakemake --lint` executes the Snakefile, which is Python code; `bio_plan` evaluates the pipeline code of all three tools.
`bio_run` and `bio_run_stop_apply` are marked destructive.

### Plan, then run

`bio_run` takes only a plan id. Before starting, it checks that the program still resolves to the same binary, that the
launch directory exists and that the pipeline file, the `nextflow.config` files (pipeline and launch directory), the
params file, the Snakemake config and profile files and the WDL inputs file have the same sha256 as at planning time.
Then it runs exactly the saved arguments and removes the plan. Plans expire after 24 hours.

The run is a detached process: its stdout and stderr go to `runs/<id>.log`, the PID and start time to `runs/<id>.json`.
While the server is alive, it records the exit code when the process ends. If the server was restarted during a run,
`bio_run_status` checks the PID (on Linux also its command line) and guesses the outcome from the end of the log. Records
of finished runs, their logs and Nextflow reports are removed after 7 days.

| Tool | Command started by `bio_run` |
|---|---|
| Nextflow | `nextflow run <main.nf> [-params-file F] [-profile P] [-work-dir D] [-resume] -with-report <data>/runs/<id>-report.html` |
| Snakemake | `snakemake [targets] --snakefile S --directory D --nocolor --cores N [--configfile …] [--profile P] [--software-deployment-method …]` |
| miniwdl | `miniwdl run <file.wdl> [-i inputs.json] [--task T] --dir <outputDir> --no-color` (a timestamp-named run directory is created under it) |

Stopping sends SIGTERM to the program itself; Nextflow, Snakemake and miniwdl then cancel their running tasks and exit.

## Local pipelines only, and what the tools download

The server installs and downloads nothing. It starts only programs already installed, found on `PATH` or through
`NB_BIO_NEXTFLOW`, `NB_BIO_MINIWDL`, `NB_BIO_SNAKEMAKE`.

- **Pipelines must be local.** `pipeline` is an absolute path to `main.nf` (or the directory that contains it), a
  Snakefile (or its project directory with `Snakefile` / `workflow/Snakefile`), or a `.wdl` file. Names like
  `owner/repo`, which Nextflow would download from a git hosting service, and URLs are not accepted. Clone the pipeline
  first and point to the local copy.
- **Nextflow** downloads plugins and, on the very first start of its launcher, its own runtime into `~/.nextflow`. With
  `offline: true` the server sets `NXF_OFFLINE=true`: Nextflow downloads no pipelines and no plugins (since 24.04), so the
  plugins must already be installed. Tasks run with the executor configured in `nextflow.config`.
- **Container images and Conda environments** used by the processes, rules or tasks are pulled or created by Nextflow,
  Snakemake (only with `softwareDeployment`) and the container runtime of miniwdl when the run starts. miniwdl also
  downloads input files given as URIs. The plan says so in its answer.
- Snakemake software deployment (`--software-deployment-method conda|apptainer|env-modules`) is off unless requested.

## Environment

| Variable | Meaning |
|---|---|
| `NB_BIO_NEXTFLOW`, `NB_BIO_MINIWDL`, `NB_BIO_SNAKEMAKE` | Path of the program; default — the name on `PATH`. Each program is optional |
| `PLUGIN_DATA` | Data folder for plans and runs; default — `nb-bio-pipelines` in the system temp folder. Mode 0700, files 0600 |

Programs run without a shell, with closed stdin, `NO_COLOR=1` and a time limit (lint 5 minutes, plan 30 minutes, the
run itself has none). Nextflow also gets `NXF_ANSI_LOG=false`, `NXF_DISABLE_CHECK_LATEST=true` (no check for a newer
version) and `NXF_AGENT_MODE=false` (keeps the normal log format the progress parser reads). Credentials stay where the
tools read them (their config files and the environment of the server). Answers mask passwords in URLs (`user:***@`),
`password=` / `token:` pairs and bearer tokens; params files are shown by key names only. Logs of the server go to
stderr.

## Versions

- `nextflow lint` needs Nextflow 25.04 or newer; with older versions `bio_lint` skips Nextflow files with a note.
  `-preview` needs Nextflow 22.10 or newer.
- `softwareDeployment` needs Snakemake 8 or newer. Dry-run job statistics are read from the `Job stats:` table.
- miniwdl: `check`, `input-template` and `run --json` of current releases (1.x).

## Run

```bash
npx -y @neuralbridge/bio-pipelines-mcp@1.0.0
```

Requires Node.js 20+.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake nextflow, miniwdl and snakemake programs
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
