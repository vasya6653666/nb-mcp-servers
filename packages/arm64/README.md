# @neuralbridge/arm64-mcp
MCP server for moving code and container images to ARM64 (aarch64) servers: find code tied to x86, check which
platforms base images provide, and build and start images for `linux/arm64` with `docker buildx`. It is the server behind
the `nb-arm64` power of NeuralBridge IDE, and works with any MCP client over stdio.
## Tools
| Tool | What it does | Changes |
|---|---|---|
| `arm_detect` | Machine architecture, docker and buildx versions, every builder with its platforms: is `linux/arm64` there, natively or through QEMU emulation (binfmt_misc) | nothing |
| `arm_scan_code` | Static scan of a directory for x86-specific code: Dockerfiles, SIMD intrinsics, inline assembly, compiler flags, Rust cfg and Go `*_amd64` files, scripts and CI; counts by category, a recommendation per category, `file:line` findings | nothing; no program is started |
| `arm_image_platforms` | Platforms in the registry manifest of each image, and whether `linux/arm64` (variant v8) is among them | nothing; reads manifests from registries |
| `arm_check_dockerfile` | Every `FROM` of a Dockerfile (multi-stage, `--platform`, global `ARG` defaults) with the platforms of its base image, plus static findings for the file | nothing; reads manifests from registries |
| `arm_build` | `docker buildx build --platform linux/arm64` (or several platforms); by default the result stays in the build cache, `load: true` loads a single-platform image | build cache; local images with `load`. Runs the `RUN` steps of the Dockerfile and may download base images and packages |
| `arm_run_check` | `docker run --rm --platform linux/arm64 --network none` with `uname -m`, and optionally one version-style command such as `node --version` | pulls the arm64 variant of the image; runs a program from the image in a removed container |
The first four tools are marked read-only. `arm_build` and `arm_run_check` are not read-only (they execute code from the
Dockerfile or the image) but are not destructive: nothing is pushed, published or deleted. That is why the server has no
plan/apply pairs.
`arm_scan_code` reads files only. It skips `.git`, `.hg`, `.svn`, `node_modules`, `vendor`, `dist`, `target`, `.venv`,
`venv`, `__pycache__`, symbolic links, dependency lock files, binary files and files over 1 MB, and stops after 20 000
files. Its rules are heuristics: they show where to look, and the build for `linux/arm64` is the real check. Dependencies
that ship native binaries are not analysed.
## Run
```bash
npx -y @neuralbridge/arm64-mcp@1.0.0
```
Requires Node.js 20+ and Docker with the buildx plugin on `PATH`. To use a specific binary, set `NB_ARM_DOCKER` to its path.
`arm_detect` uses `docker buildx ls --format json`, available since buildx 0.13; with older buildx it shows the plain
table. Building several platforms at once needs a builder that supports it (a `docker-container` builder, or the
containerd image store with the default `docker` driver). Building or running `linux/arm64` on an x86 machine needs QEMU
emulators registered in binfmt_misc; the server never changes the host, it only reports what is missing.
Registry credentials are the ones docker already has. Secrets in the output (passwords in URLs, `token=` values, values of
secret-looking build args) are replaced with `***`. Temporary files (build metadata) are kept in `$PLUGIN_DATA/tmp` (the
power's data folder) or, outside NeuralBridge IDE, in the system temp folder: folder mode 0700, files 0600, removed after use.
## Develop
```bash
npm install
npm test   # build + unit and end-to-end tests with a fake docker binary
```
## License
Apache-2.0. See `LICENSE` and `NOTICE`.
