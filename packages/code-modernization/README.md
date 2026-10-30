# @neuralbridge/code-modernization-mcp

MCP server for modernizing Java and Kotlin code with [OpenRewrite](https://docs.openrewrite.org) recipes, run through the
project's own Maven or Gradle build without changing the build files. It is the server behind the `nb-code-modernization`
power of NeuralBridge IDE, and works with any MCP client over stdio.

Typical recipes: upgrade the Java version (`org.openrewrite.java.migrate.UpgradeToJava21`), Spring Boot
(`org.openrewrite.java.spring.boot3.UpgradeSpringBoot_3_5`), JUnit 4 → 5
(`org.openrewrite.java.testing.junit5.JUnit4to5Migration`), `javax` → `jakarta`
(`org.openrewrite.java.migrate.jakarta.JavaxMigrationToJakarta`), logging libraries, removed and deprecated APIs.

## Tools

| Tool | What it does | Changes |
|---|---|---|
| `mod_detect` | Maven, Gradle and git with versions; with `dir`: build type, wrapper distributions (downloaded or not), modules, declared Java level, Spring Boot / JUnit 4 / `javax` / Log4j 1 found in the build files, OpenRewrite plugin already in the build, git state, candidate recipes | nothing (reads files; wrappers are not started) |
| `mod_discover` | Runs the OpenRewrite `discover` goal / `rewriteDiscover` task and lists recipe names, filtered by a substring | build output (`target/`, `build/`); downloads, see below |
| `mod_plan` | Runs `dryRun` / `rewriteDryRun` for the given recipes; shows changed files with +/− counts and the patch; saves a plan | build output; a plan in the data folder |
| `mod_apply_plan` | Applies exactly the saved patch with `git apply`, once | **source files of the project** |

Only `mod_detect` is marked read-only: `mod_discover` and `mod_plan` run the project build, so its build plugins and
annotation processors execute. `mod_apply_plan` is marked destructive. Running recipes straight into the sources
(`rewrite:run`, `rewriteRun`) is deliberately not offered.

## Plan, then apply

`mod_plan` copies the patch from the dry run into `$PLUGIN_DATA/plans/<id>.patch` and records the build directory, the
recipes, plugin and recipe versions, the sha256 of the patch and **the sha256 of every file the patch touches**, plus
`git rev-parse HEAD` and whether the working tree was clean. It warns when the tree has uncommitted changes or the project
is not in git.

`mod_apply_plan` takes the plan id and the same `dir`. It checks that the saved patch is intact and that none of the
touched files changed since the plan, then runs `git apply --check` and `git apply` from the base of the patch paths (the
git repository root, or the project directory outside git — `git apply` works without a repository). Recipes are not run
again, so exactly the reviewed patch is applied. A plan is removed after one attempt and expires after 24 hours.

Patch paths are relative to the git repository root, as OpenRewrite writes them; paths that leave the project are rejected.

## Downloads

The server downloads and installs nothing itself. Maven or Gradle, however, fetch the OpenRewrite plugin and the recipe
artifacts from the repositories configured for the project (your `settings.xml`, mirrors, Gradle repositories) when they
are not in the local cache yet; the first line of every `mod_discover` / `mod_plan` answer says so. A project wrapper
(`./mvnw`, `./gradlew`) also downloads its Maven or Gradle distribution on first use; `mod_detect` reports whether it is
already cached and never starts a wrapper. Pass `offline: true` to run Maven with `-o` or Gradle with `--offline`.

## Versions

Defaults, checked on 2026-10-29. They form one consistent release (OpenRewrite core 8.89.0) that is available without
credentials: the Maven plugin and the recipe modules from Maven Central, the Gradle plugin from the Gradle Plugin Portal.

| What | Default |
|---|---|
| `org.openrewrite.maven:rewrite-maven-plugin` | `6.46.1` |
| Gradle plugin `org.openrewrite.rewrite` (`org.openrewrite:plugin`) | `7.39.0` |
| Recipe modules | `org.openrewrite.recipe:rewrite-migrate-java:3.42.0`, `rewrite-spring:6.37.0`, `rewrite-testing-frameworks:3.44.0`, `rewrite-logging-frameworks:3.32.0`, `rewrite-static-analysis:2.41.0` |

Override them per call with `pluginVersion` and `recipeArtifacts` (`groupId:artifactId:version`; the list replaces the
defaults). Newer OpenRewrite releases are published to OpenRewrite's own artifact repository
(`https://artifacts.codegenomeproject.org/maven`), which needs a download token; see the
[OpenRewrite quickstart](https://docs.openrewrite.org/running-recipes/getting-started). For Maven, declare that repository
with its credentials in `~/.m2/settings.xml` as the documentation shows. For Gradle, start the IDE (or the server) with
`ORG_GRADLE_PROJECT_codegenomeUsername` and `ORG_GRADLE_PROJECT_codegenomePassword` set; the init script then adds that
repository the same way the documentation does.

## How the build is run

Maven (no change to `pom.xml`):

```
mvn -B -ntp -U -Dstyle.color=never org.openrewrite.maven:rewrite-maven-plugin:<version>:dryRun \
  -Drewrite.recipeArtifactCoordinates=<g:a:v,...> -Drewrite.activeRecipes=<recipes> \
  -Drewrite.exportDatatables=false -Drewrite.failOnInvalidActiveRecipes=true -DfailOnDryRunResults=false \
  -DreportOutputDirectory=<temporary folder in the data folder>
```

`discover` uses the same coordinates with `-Ddetail=false`. If `pom.xml` already configures `rewrite-maven-plugin`, its
`<configuration>` takes precedence over command-line values; `mod_plan` compares the plugin's `Using active recipe(s)` line
with the requested recipes and refuses on a mismatch.

Gradle (no change to the build scripts): a temporary init script (mode 0600, in the data folder, deleted right after the
run) applies `org.openrewrite.gradle.RewritePlugin` to the root project and adds the recipe modules to its `rewrite`
configuration, then `gradle --init-script <file> --no-daemon --console=plain rewriteDryRun -Drewrite.activeRecipes=…`
(or `rewriteDiscover`). The patch is read from `build/reports/rewrite/rewrite.patch`. OpenRewrite documents that an init
script cannot be combined with a `rewrite` section in the build, so the tools refuse when the build already applies
the plugin.

Programs are started without a shell, with closed stdin, hidden windows on Windows, `NO_COLOR=1` and `TERM=dumb`.
Timeouts: discover 15 minutes, dry run 60 minutes, git 2 minutes.

## Requirements and environment

- Node.js 20+.
- A JDK that can build the project.
- Maven 3.6.1 or newer (for `-ntp`) or the project's `./mvnw`; Gradle or the project's `./gradlew`. Order: the
  `NB_MOD_MAVEN` / `NB_MOD_GRADLE` variable, then the project wrapper (unless `useWrapper: false`), then `mvn` / `gradle`
  on `PATH`. A wrapper without the executable bit is reported with a `chmod +x` hint, not silently replaced.
- git for `mod_apply_plan` (`NB_MOD_GIT`, then `PATH`).
- **Windows:** `mvn.cmd`, `mvnw.cmd`, `gradle.bat` and `gradlew.bat` are batch scripts and need a shell, which this server
  never uses, so it cannot start them. Open the project in WSL or on Linux/macOS, where `./mvnw`, `./gradlew`, `mvn` and
  `gradle` work, or point the variable to a native executable. git (`git.exe`) works on Windows.

| Variable | Meaning |
|---|---|
| `NB_MOD_MAVEN` | Maven executable to use instead of the wrapper and `PATH` |
| `NB_MOD_GRADLE` | Gradle executable to use instead of the wrapper and `PATH` |
| `NB_MOD_GIT` | git executable |
| `PLUGIN_DATA` | data folder (set by NeuralBridge IDE); otherwise `<system temp>/nb-code-modernization` |

Maven and Gradle keep using your own configuration: `~/.m2/settings.xml`, `MAVEN_OPTS`, `MAVEN_USER_HOME`,
`GRADLE_USER_HOME`, `~/.gradle/gradle.properties`.

## Secrets

Credentials stay in the environment and in the build tools' own configuration files; the server never reads or stores
them. Passwords in repository URLs (`user:***@`), `password=` / `token:` values, `<password>` elements and bearer tokens are
masked in build errors and in the patch shown to the model; the saved patch stays exact. The data folder has mode 0700 and
its files 0600. Logs go to stderr only.

## Develop

```bash
npm install
npm test   # build + unit and end-to-end tests with fake mvn and gradle and the real git (apply tests skip without git)
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
