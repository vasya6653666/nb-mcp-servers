# NeuralBridge MCP servers

MCP servers by NeuralBridge, published to npm under `@neuralbridge`. Each server lives in its own folder under
`packages/` and is the server behind a power of NeuralBridge IDE. Every server also works with any MCP client over stdio.

| Package | Folder | What it does |
|---|---|---|
| [`@neuralbridge/arm64-mcp`](https://www.npmjs.com/package/@neuralbridge/arm64-mcp) | [`packages/arm64`](packages/arm64) | MCP server for moving code and container images to ARM64 (aarch64): find x86-only code, check image platforms, build and smoke-test images for linux/arm64 with docker buildx |
| [`@neuralbridge/bio-pipelines-mcp`](https://www.npmjs.com/package/@neuralbridge/bio-pipelines-mcp) | [`packages/bio-pipelines`](packages/bio-pipelines) | MCP server for bioinformatics pipelines with Nextflow, miniwdl and Snakemake: detect, lint, dry-run plan, start a reviewed run in the background, follow and stop it |
| [`@neuralbridge/ci-pipelines-mcp`](https://www.npmjs.com/package/@neuralbridge/ci-pipelines-mcp) | [`packages/ci-pipelines`](packages/ci-pipelines) | MCP server for CI pipelines: lint GitHub Actions workflows with actionlint, validate .gitlab-ci.yml with glab, list and dry-run workflow jobs locally with act, run a reviewed act plan |
| [`@neuralbridge/code-modernization-mcp`](https://www.npmjs.com/package/@neuralbridge/code-modernization-mcp) | [`packages/code-modernization`](packages/code-modernization) | MCP server for modernizing Java and Kotlin code with OpenRewrite recipes through the project's Maven or Gradle build: discover recipes, dry-run them into a reviewable patch, apply exactly that patch with git |
| [`@neuralbridge/containers-mcp`](https://www.npmjs.com/package/@neuralbridge/containers-mcp) | [`packages/containers`](packages/containers) | MCP server for Docker and Podman: containers, images, logs, inspect with masked secrets, image builds, and Compose up/down or removals only through a reviewed plan |
| [`@neuralbridge/database-migrations-mcp`](https://www.npmjs.com/package/@neuralbridge/database-migrations-mcp) | [`packages/database-migrations`](packages/database-migrations) | MCP server for database schema migrations with Flyway, Liquibase and Atlas: status, validation, a reviewed plan with the SQL to run, and applying exactly that plan |
| [`@neuralbridge/infra-as-code-mcp`](https://www.npmjs.com/package/@neuralbridge/infra-as-code-mcp) | [`packages/infra-as-code`](packages/infra-as-code) | MCP server for Terraform and OpenTofu projects: format, validate, plan with a readable summary, apply a reviewed plan |
| [`@neuralbridge/kubernetes-mcp`](https://www.npmjs.com/package/@neuralbridge/kubernetes-mcp) | [`packages/kubernetes`](packages/kubernetes) | MCP server for Kubernetes clusters through kubectl and Helm: read objects, logs and events, diff manifests and apply a reviewed plan, plan and run deletions and Helm upgrades |
| [`@neuralbridge/llm-evals-mcp`](https://www.npmjs.com/package/@neuralbridge/llm-evals-mcp) | [`packages/llm-evals`](packages/llm-evals) | MCP server for promptfoo evaluations: find and validate configs, count model calls before a run, run a reviewed plan, summarize results |
| [`@neuralbridge/local-models-mcp`](https://www.npmjs.com/package/@neuralbridge/local-models-mcp) | [`packages/local-models`](packages/local-models) | MCP server for models the user runs locally: list, inspect, query and embed with Ollama and llama.cpp llama-server over their HTTP APIs; download and delete Ollama models only through an approved plan |
| [`@neuralbridge/observability-mcp`](https://www.npmjs.com/package/@neuralbridge/observability-mcp) | [`packages/observability`](packages/observability) | MCP server for read-only observability: query Prometheus metrics, Loki logs, Grafana dashboards and Alertmanager alerts over their HTTP APIs |
| [`@neuralbridge/security-scanning-mcp`](https://www.npmjs.com/package/@neuralbridge/security-scanning-mcp) | [`packages/security-scanning`](packages/security-scanning) | MCP server for local security scans: Trivy for vulnerable dependencies, misconfigurations and container images, Semgrep for code patterns, Gitleaks for leaked secrets. Secret values are never returned |
| [`@neuralbridge/serverless-mcp`](https://www.npmjs.com/package/@neuralbridge/serverless-mcp) | [`packages/serverless`](packages/serverless) | MCP server for serverless workloads through the Knative CLI (kn) and the OpenFaaS CLI (faas-cli): list and describe services, revisions and functions, read logs, build functions, and deploy or remove them only through a reviewed plan |
| [`@neuralbridge/workflow-orchestration-mcp`](https://www.npmjs.com/package/@neuralbridge/workflow-orchestration-mcp) | [`packages/workflow-orchestration`](packages/workflow-orchestration) | MCP server for workflow engines through the Temporal CLI and the Argo Workflows CLI: list and inspect executions, read a payload-free event history and logs, lint manifests, and start, signal, submit, stop or retry only after a reviewed plan |

## Releases

A package is published by pushing a tag `<folder>-v<version>`, for example `infra-as-code-v1.0.0`. The `publish`
workflow builds and tests the package and publishes it to npm with provenance.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
