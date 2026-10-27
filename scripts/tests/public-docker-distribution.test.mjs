import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public Dockerfile provides native multi-arch core, browser, and redistributable pinned CLI targets", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const normalizedDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");
  const nodeImage =
    "node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82";
  const nodeStages = Array.from(
    dockerfile.matchAll(/^FROM (\S+) AS (build|runtime-base)$/gm),
    ([, image, stage]) => ({ image, stage })
  );

  assert.match(dockerfile, /FROM .* AS core/);
  assert.match(dockerfile, /FROM .* AS browser/);
  assert.match(dockerfile, /FROM .* AS cli/);
  assert.deepEqual(nodeStages, [
    { image: nodeImage, stage: "build" },
    { image: nodeImage, stage: "runtime-base" }
  ]);
  assert.equal(
    normalizedDockerfile.match(/apt-get install -y --no-install-recommends[^&]*liblzma5/g)?.length,
    3,
    "build, runtime, and browser apt transactions must explicitly install patched liblzma5"
  );
  assert.match(dockerfile, /ARG TARGETARCH/);
  assert.match(dockerfile, /ARG NPM_VERSION=11\.18\.0/);
  assert.match(
    normalizedDockerfile,
    /npm install --global --ignore-scripts --no-audit --no-fund "npm@\$\{NPM_VERSION\}"/
  );
  assert.match(dockerfile, /await r\.json\(\)/);
  assert.match(dockerfile, /body\.ok !== true/);
  assert.match(dockerfile, /rotate-owner-setup-token\.mjs/);
  assert.match(dockerfile, /@opencode\/cli@2\.0\.32/);
  assert.doesNotMatch(dockerfile, /@openai\/codex|@google\/gemini-cli|@anthropic-ai\/claude-code|run-deepseek-cli/);
  const installer = await readFile(join(root, "deploy/docker/provider-install.mjs"), "utf8");
  assert.match(installer, /@openai\/codex@0\.145\.0/);
  assert.match(installer, /Unsupported optional provider/);
  assert.doesNotMatch(dockerfile, /docker\.sock/);
  assert.match(dockerfile, /COPY --from=build --chown=spaceapp:spaceapp \/app\/LICENSE \/app\/NOTICE \/app\/THIRD_PARTY_NOTICES\.md \.\//);
});

test("public container images identify their repository and license for GHCR", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.source=https:\/\/github\.com\/oll4com\/spaceapp$/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.licenses=MIT$/m
  );
});

test("CLI image removes the npm download cache in the same layer as bundled CLI installation", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const normalizedCliStage = cliStage.replace(/\\\r?\n\s*/g, " ");

  assert.match(
    normalizedCliStage,
    /RUN apt-get update[\s\S]*npm install[\s\S]*@opencode\/cli@2\.0\.32[\s\S]*&& npm cache clean --force/
  );
  // Pilot F18: agents check their work with python3; the apt lists leave in the same layer.
  assert.match(normalizedCliStage, /apt-get install -y --no-install-recommends python3-minimal\s+&& rm -rf \/var\/lib\/apt\/lists\/\*/);
});

test("CLI image resolves the default room project /opt/spaceapp to the documented /etc session directory", async () => {
  // 1.1.3 devtest: without it the Getting Started OpenCode pane exited with chdir(2) failed.
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  assert.match(cliStage, /^RUN ln -s \/etc \/opt\/spaceapp$/m);
  const coreStage = dockerfile.match(/FROM runtime-base AS core([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  assert.doesNotMatch(coreStage, /ln -s \/etc \/opt\/spaceapp/);
  const agents = await readFile(join(root, "starter-memory", "AGENTS.md"), "utf8");
  assert.match(agents, /cwd=\/etc/);
});

test("runtime images patch fixable vulnerabilities in npm's bundled dependencies", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const runtimeStage =
    dockerfile.match(/FROM [^\n]+ AS runtime-base([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const normalizedRuntimeStage = runtimeStage
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/\s+/g, " ");

  assert.match(
    normalizedRuntimeStage,
    /npm pack --ignore-scripts --no-audit --no-fund --pack-destination \/tmp\/npm-security-patches brace-expansion@5\.0\.12 tar@7\.5\.21 ip-address@10\.7\.4 undici@6\.29\.1 postcss-selector-parser@7\.1\.6/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/brace-expansion-5\.0\.12\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/brace-expansion --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/tar-7\.5\.21\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/ip-address-10\.7\.4\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/ip-address --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/postcss-selector-parser-7\.1\.6\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/postcss-selector-parser --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/undici-6\.29\.1\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/undici --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /rm -rf \/tmp\/npm-security-patches && npm cache clean --force/
  );
});

test("public Compose runs without host Docker access or development credentials", async () => {
  const compose = await readFile(
    join(root, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );

  for (const service of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "postgres", "temporal"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"));
  }
  assert.match(compose, /127\.0\.0\.1|SPACEAPP_BIND_HOST/);
  assert.match(compose, /SPACE_BROWSER_SESSIONS_ENABLED: "\$\{SPACEAPP_BROWSER_ENABLED\}"/);
  assert.match(compose, /^    profiles: \["standard"\]$/m);
  for (const variable of [
    "SPACEAPP_CORE_MEMORY_LIMIT",
    "SPACEAPP_CLI_MEMORY_LIMIT",
    "SPACEAPP_BROWSER_MEMORY_LIMIT",
    "SPACEAPP_POSTGRES_MEMORY_LIMIT",
    "SPACEAPP_TEMPORAL_MEMORY_LIMIT"
  ]) {
    assert.match(compose, new RegExp(`mem_limit: "\\$\\{${variable}\\}"`));
  }
  assert.match(compose, /SPACE_CODEX_HOME: \/var\/lib\/spaceapp-cli\/providers\/codex/);
  assert.match(compose, /SPACE_CODEX_GOALS_DB_PATH: \/var\/lib\/spaceapp\/codex-goals\.sqlite/);
  assert.match(compose, /SPACE_CODEX_APP_SERVER_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CODEX_ROUTE_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CLI_WORKSPACE_ROOT: \/workspaces/);
  assert.match(compose, /SPACE_MEMORY_GRAPH_ROOT: \/var\/lib\/spaceapp\/memory-graph/);
  assert.match(compose, /SPACE_MEMORY_INDEX_PATH: \/var\/lib\/spaceapp\/memory\/space_memory\.md/);
  assert.match(compose, /SPACE_MEMORY_MONTHLY_PATH: \/var\/lib\/spaceapp\/memory\/space_memory_monthly\.md/);
  assert.match(compose, /SPACE_MEMORY_LOCK_PATH: \/var\/lib\/spaceapp\/memory\/\.memory\.lock/);
  assert.doesNotMatch(compose, /gemini_history|SPACE_GEMINI_MEMORY/);
  assert.match(compose, /SPACE_TELEGRAM_SECRET_ROOT: \/var\/lib\/spaceapp\/telegram/);
  assert.match(
    compose,
    /SPACE_TELEGRAM_OWNERSHIP_MANIFEST: \/var\/lib\/spaceapp\/integrations\/telegram\/thread-ownership\.json/
  );
  assert.match(
    compose,
    /SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: \/var\/lib\/spaceapp\/codex-cli-mode-defaults-v1\.json/
  );
  assert.match(compose, /spaceapp-workspaces:\/workspaces/);
  assert.match(compose, /exec \/etc\/temporal\/entrypoint\.sh autosetup/);
  assert.match(compose, /cluster health.*&& temporal operator namespace describe --namespace default/);
  assert.doesNotMatch(compose, /space-dev|dev-only|docker\.sock/);
  assert.doesNotMatch(compose, /\/srv\/space|\/home\/spaceapp-user|\/etc\/docs|olla\.gr|Legacy/i);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*\S+/);
  assert.doesNotMatch(compose, /^name:/m);

  const coreBlock = compose.match(/^  spaceapp-core:[\s\S]*?(?=^  spaceapp-cli:)/m)?.[0] || "";
  assert.doesNotMatch(coreBlock, /spaceapp-cli-state|spaceapp-secrets\/providers|secrets\/providers/);

  for (const [service, nextService] of [
    ["spaceapp-core", "spaceapp-cli"],
    ["spaceapp-cli", "spaceapp-browser"],
    ["spaceapp-browser", "postgres"]
  ]) {
    const block =
      compose.match(new RegExp(`^  ${service}:[\\s\\S]*?(?=^  ${nextService}:)`, "m"))?.[0] || "";
    assert.match(block, /^    security_opt:\n      - no-new-privileges:true$/m);
    assert.doesNotMatch(block, /cap_drop:/);
  }
});

test("container entrypoints load secrets and keep CLI root only for explicit host-root access", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const cli = await readFile(join(root, "deploy", "docker", "cli-entrypoint.sh"), "utf8");

  assert.match(core, /SPACE_DATABASE_URL_FILE/);
  assert.match(core, /SPACE_SETUP_TOKEN_SOURCE_FILE/);
  assert.match(core, /install -o spaceapp -g spaceapp -m 0400/);
  assert.match(core, /export SPACE_SETUP_TOKEN_FILE/);
  assert.match(core, /gosu spaceapp/);
  assert.match(
    cli,
    /if \[ "\$\{SPACEAPP_CLI_HOST_ROOT_ACCESS:-false\}" = "true" \]; then\s+exec gosu root:spaceapp node packages\/cli-host\/dist\/main\.js\s+fi/
  );
  assert.match(cli, /gosu spaceapp/);
  assert.match(
    cli,
    /chown -hR spaceapp:spaceapp \/var\/lib\/spaceapp-cli \/var\/lib\/spaceapp\/memory/
  );
  assert.doesNotMatch(cli, /chown -R[^\n]*\/workspaces/);
  assert.match(cli, /rm -f -- "\$destination"/);
  assert.doesNotMatch(cli, /(?:-n|-z).*SPACEAPP_CLI_HOST_ROOT_ACCESS/);
  assert.doesNotMatch(`${core}\n${cli}`, /set -x/);
});

test("host-root CLI socket remains accessible to the non-root core service", async () => {
  const cli = await readFile(join(root, "deploy", "docker", "cli-entrypoint.sh"), "utf8");
  const cliMain = await readFile(join(root, "packages", "cli-host", "src", "main.ts"), "utf8");

  assert.match(
    cli,
    /SPACEAPP_CLI_HOST_ROOT_ACCESS:-false\}" = "true" \]; then\s+exec gosu root:spaceapp node packages\/cli-host\/dist\/main\.js\s+fi/
  );
  assert.match(cliMain, /createCliHostServer\(\{ socketPath, socketMode: 0o660, registry \}\)/);
});

test("an OpenCode pane still starts when the first-run free-model check fails; credential smoke stays strict", async () => {
  // 1.1.3 devtest (vm218): a failed check exited the wrapper (set -e) and left the
  // Getting Started pane without a CLI ("CLI process exited with code 1").
  const wrapper = await readFile(join(root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8");
  const launch = wrapper.slice(wrapper.lastIndexOf('if [ "$runtime_name" = "opencode" ]; then'));
  assert.match(launch, /\*\) if ! node \/app\/deploy\/docker\/opencode-first-run\.mjs; then\s+echo "[^"]*OpenCode starts anyway[^"]*" >&2\s+fi ;;/);
  const smoke = wrapper.match(/credential-smoke\)[\s\S]*?;;/)?.[0] || "";
  assert.match(smoke, /^\s+node \/app\/deploy\/docker\/opencode-first-run\.mjs$/m);
  assert.match(wrapper, /^set -euo pipefail$/m);
});

test("the core image carries the Python the SQLite worker needs (1.1.8)", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = Object.fromEntries(dockerfile.split(/^(?=FROM )/m).map((stage) => [stage.match(/^FROM \S+ AS (\S+)/)?.[1], stage]));
  const core = stages.core.replace(/\\\n/g, " ");
  assert.match(core, /apt-get install -y --no-install-recommends python3\s+&& rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(stages.core, /import sqlite3, sys; assert sys\.version_info >= \(3, 12\)/);
  assert.ok((await readFile(join(root, "apps", "api", "src", "databases", "sqlite-adapter.ts"), "utf8")).includes("python3"));
});

test("core never runs OpenCode itself", async () => {
  // 1.1.7 (decision B): CLIs live only in the CLI container; core asks its credential agent instead.
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = Object.fromEntries(dockerfile.split(/^(?=FROM )/m).map((stage) => [stage.match(/^FROM \S+ AS (\S+)/)?.[1], stage]));
  assert.match(stages.cli, /@opencode\/cli@/);
  for (const name of ["build", "runtime-base", "core", "browser"]) assert.doesNotMatch(stages[name], /@opencode\/cli|opencode-ai/, name);

  const src = join(root, "apps", "api", "src");
  const read = (name) => readFile(join(src, name), "utf8");
  // The only places that start OpenCode or a wrapper's credential-smoke or credential-observation in the API process.
  const direct = /spawn\("opencode"|"\/usr\/local\/bin\/opencode"|\["credential-smoke"\]|\[definition\.credentialObservationAction\]/;
  const found = execFileSync("grep", ["-rlE", direct.source, "--include=*.ts", "--exclude-dir=__tests__", src], { encoding: "utf8" })
    .trim().split("\n").map((path) => path.slice(src.length + 1)).sort();
  assert.deepEqual(found, ["cli-runtimes.ts", "cli-terminal.ts", "opencode-model-bench.ts", "room-agent-model-resolver.ts", "setup-assistant.ts", "setup-room-agent-check.ts"]);
  // Each one takes the public credential host's path when there is one.
  const app = await read("app.ts");
  assert.match(app, /const publicCredentialHost = createPublicCredentialHost\(config\);\n  const runOpenCode = publicCredentialHost\?\.openCodeText \?\? runOpenCodeText;/);
  assert.match(app, /new CliTerminalManager\(\{[^}]*?credentialHost: publicCredentialHost,/);
  assert.match(app, /checkCredential: \(runtime\) => checkCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  assert.match(app, /observeCredential: \(runtime\) => observeCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  assert.match(app, /new OpencodeModelBenchService\(\{\n    execVerbose: publicCredentialHost\n      \? \(provider\) => publicCredentialHost\.openCodeModels\(provider\)/);
  assert.match(app, /createOpenCodeTextModel\(\{ run: runOpenCode \}\)/);
  assert.match(app, /completeRoomAgentPrompt\(\{[^}]*runOpenCode \}\)/);
  assert.doesNotMatch(app, /createOpenCodeTextModel\(\)|checkCliRuntimeCredential\(runtime\)|observeCliRuntimeCredential\(runtime\)/);
  assert.match(await read("cli-terminal.ts"), /this\.options\.credentialHost\n\s+\? await this\.options\.credentialHost\.execute\(runtime\.detectedCommandPath, \["credential-smoke"\]/);
  // First Setup (1.1.8): the setup assistant and the Room Agent check take the credential host's OpenCode before their own.
  const setupWiring = await read("setup-wiring.ts");
  assert.match(setupWiring, /\.\.\.\(publicCredentialHost \? \{ openCodeText: publicCredentialHost\.openCodeText, openCodeModels: publicCredentialHost\.openCodeModels \} : \{\}\)/);
  assert.match(setupWiring, /\.\.\.\(publicCredentialHost \? \{ openCodeModels: publicCredentialHost\.openCodeModels,\s+checkFreeModel: \(modelId: string\) => checkNativeSetupFreeModel\(publicCredentialHost, "opencode-vscode-parity", modelId\) \} : \{\}\)/);
  const setupAssistant = await read("setup-assistant.ts");
  assert.ok(setupAssistant.indexOf("if (options.openCodeText && options.openCodeModels)") >= 0 &&
    setupAssistant.indexOf("if (options.openCodeText && options.openCodeModels)") < setupAssistant.indexOf("openCodeExecutor("));
  const roomAgentCheck = await read("setup-room-agent-check.ts");
  assert.ok(roomAgentCheck.indexOf("if (options.checkFreeModel && options.openCodeModels)") >= 0 &&
    roomAgentCheck.indexOf("if (options.checkFreeModel && options.openCodeModels)") < roomAgentCheck.indexOf("openCodeExecutor("));
  assert.match(await read("room-agent.ts"), /runOpenCode = runOpenCodeText \} = input;/);
  assert.doesNotMatch(await read("room-agent.ts"), /await runOpenCodeText\(/);
});

test("public CLI wrapper isolates provider state and supports protected DeepSeek setup", async () => {
  const wrapper = await readFile(join(root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8");
  const credentialStatusBlock = wrapper.match(/credential-status\)[\s\S]*?;;/)?.[0] || "";

  assert.match(wrapper, /DISABLE_UPDATES=1/);
  assert.match(wrapper, /umask 077/);
  assert.match(wrapper, /deepseek\.key/);
  assert.match(wrapper, /export USER=spaceapp/);
  assert.match(wrapper, /login\)\n\s+ensure_optional_provider\n\s+ensure_runtime_dirs/);
  assert.doesNotMatch(credentialStatusBlock, /ensure_runtime_dirs/);
  assert.match(wrapper, /opencode\) exec "\$command_name" auth login/);
  // Pilot finding F4: OpenCode uses the Anthropic and OpenAI keys set for Claude Code and Codex.
  const opencodeBlock = wrapper.match(/\n  opencode\)\n[\s\S]*?;;/)?.[0] || "";
  assert.match(opencodeBlock, /ANTHROPIC_API_KEY="\$\(cat "\$credential_root\/claude\.key"\)"/);
  assert.match(opencodeBlock, /OPENAI_API_KEY="\$\(cat "\$credential_root\/codex\.key"\)"/);
  assert.match(wrapper, /vendor\/claude\/node_modules\/\.bin\/claude/);
  assert.match(wrapper, /autohand\)\n\s+command_name="autohand"/);
  assert.match(wrapper, /AUTOHAND_HOME="\$state_root"/);
  assert.match(wrapper, /AUTOHAND_API_KEY=/);
  assert.match(wrapper, /cursor\)\n\s+command_name="cursor-agent"/);
  assert.match(wrapper, /CURSOR_CONFIG_DIR="\$state_root"/);
  assert.match(wrapper, /AGENT_CLI_CREDENTIAL_STORE="file"/);
  assert.match(wrapper, /copilot\)\n\s+command_name="copilot"/);
  assert.match(wrapper, /COPILOT_HOME="\$state_root"/);
  assert.match(wrapper, /autohand\) \[ -s "\$state_root\/config\.json" \]/);
  assert.match(wrapper, /cursor\) \[ -s "\$state_root\/\.config\/cursor\/auth\.json" \]/);
  assert.match(wrapper, /copilot\) \[ -s "\$state_root\/config\.json" \]/);
  assert.doesNotMatch(wrapper, /setup_deepseek_credential|read -r -s/);
  assert.doesNotMatch(wrapper, /Legacy|\/home\/spaceapp-user|\/srv\/space/i);
});

test("memory-names moves legacy gemini_history memory once and keeps the old names as links (pilot F13)", async () => {
  const memory = await mkdtemp(join(tmpdir(), "spaceapp-memory-names-"));
  try {
    await writeFile(join(memory, "gemini_history.md"), "# owner index\n");
    await writeFile(join(memory, "gemini_history_monthly.md"), "# owner month\n");
    for (let run = 0; run < 2; run += 1) execFileSync("sh", [join(root, "deploy", "docker", "memory-names.sh"), memory]);
    assert.equal(await readFile(join(memory, "space_memory.md"), "utf8"), "# owner index\n");
    assert.equal(await readFile(join(memory, "space_memory_monthly.md"), "utf8"), "# owner month\n");
    assert.equal(await readlink(join(memory, "gemini_history.md")), "space_memory.md");
    assert.equal(await readlink(join(memory, "gemini_history_monthly.md")), "space_memory_monthly.md");
    assert.ok((await lstat(join(memory, "space_memory.md"))).isFile());
  } finally {
    await rm(memory, { recursive: true, force: true });
  }
  const fresh = await mkdtemp(join(tmpdir(), "spaceapp-memory-names-"));
  try {
    execFileSync("sh", [join(root, "deploy", "docker", "memory-names.sh"), fresh]);
    await assert.rejects(lstat(join(fresh, "gemini_history.md")));
    await assert.rejects(lstat(join(fresh, "space_memory.md")));
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("core seeds generic starter memory only when mutable owner memory is absent", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const starter = await readFile(join(root, "starter-memory", "space_memory.md"), "utf8");

  assert.match(core, /SPACE_MEMORY_ROOT/);
  assert.match(core, /SPACE_STARTER_MEMORY_ROOT/);
  assert.match(core, /sh deploy\/docker\/memory-names\.sh "\$SPACE_MEMORY_ROOT"\nif \[ ! -e "\$SPACE_MEMORY_ROOT\/space_memory\.md" \]/);
  assert.match(core, /if \[ ! -e "\$SPACE_MEMORY_MONTHLY_PATH" \]/);
  assert.match(core, /space_memory_monthly\.md/);
  assert.doesNotMatch(core, /gemini_history|SPACE_GEMINI_MEMORY/);
  assert.match(starter, /^# SpaceApp Memory/m);
  assert.doesNotMatch(starter, /\/etc\/docs|\/srv\/space|spaceapp-user|oll4\.com/i);
});

test("Dockerfile stages per-service runtime trees instead of shipping the full monorepo in runtime-base", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = Object.fromEntries(
    dockerfile.split(/^(?=FROM )/m).map((stage) => [stage.match(/^FROM \S+ AS (\S+)/)?.[1], stage])
  );

  assert.match(
    stages.build,
    /node deploy\/docker\/stage-container-runtime\.mjs --source \/app --output \/app-targets --arch "\$\{TARGETARCH:-\}"/
  );
  for (const forbidden of [
    "COPY --from=build --chown=spaceapp:spaceapp /app/node_modules",
    "COPY --from=build --chown=spaceapp:spaceapp /app/apps",
    "COPY --from=build --chown=spaceapp:spaceapp /app/packages",
    "COPY --from=build --chown=spaceapp:spaceapp /app/agent-skills"
  ]) {
    assert.equal(stages["runtime-base"].includes(forbidden), false, forbidden);
  }
  assert.match(stages.core, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/core\/ \.\//);
  assert.match(stages.browser, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/browser\/ \.\//);
  assert.match(stages.cli, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/cli\/ \.\//);
  assert.match(stages["runtime-base"], /useradd --uid 10001 --gid 10001/);
  assert.match(stages.core, /ENTRYPOINT \["\/app\/deploy\/docker\/core-entrypoint\.sh"\]/);
  assert.match(stages.browser, /ENTRYPOINT \["\/app\/deploy\/docker\/browser-entrypoint\.sh"\]/);
  assert.match(stages.cli, /ENTRYPOINT \["\/app\/deploy\/docker\/cli-entrypoint\.sh"\]/);
});

test("core can import the CLI host client without shipping node-pty", async () => {
  const spawnSource = await readFile(join(root, "packages/cli-host/src/node-pty-spawn.ts"), "utf8");
  const apiManifest = JSON.parse(await readFile(join(root, "apps/api/package.json"), "utf8"));

  assert.match(spawnSource, /createRequire\(import\.meta\.url\)/);
  assert.match(spawnSource, /require\("node-pty"\)/);
  assert.doesNotMatch(spawnSource, /^import\s+\{[^}]*\}\s+from\s+"node-pty"/m);
  assert.equal(apiManifest.dependencies["node-pty"], undefined);
});

test("staged runtime trees keep only the modules and native builds each target runs", async () => {
  const { stageAllContainerTargets } = await import(
    pathToFileURL(join(root, "deploy/docker/stage-container-runtime.mjs")).href
  );
  const source = await mkdtemp(join(tmpdir(), "spaceapp-stage-src-"));
  const output = await mkdtemp(join(tmpdir(), "spaceapp-stage-out-"));
  const write = async (rel, contents) => {
    await mkdir(join(source, dirname(rel)), { recursive: true });
    await writeFile(join(source, rel), contents);
  };
  const pkg = (name, dependencies = {}, optionalDependencies = {}) =>
    JSON.stringify({ name, version: "1.0.0", dependencies, optionalDependencies });

  try {
    await write("package.json", JSON.stringify({ name: "space", private: true }));
    await write("package-lock.json", "{}\n");
    await write("apps/api/package.json", pkg("@space/api", {
      "@space/db": "0.2.5",
      "@space/cli-host": "0.2.5",
      nanoid: "1.0.0",
      "node-pty": "1.1.0",
      "@temporalio/client": "1.24.0",
      "pdfjs-dist": "6.3.289"
    }));
    await write("apps/api/dist/browser-host-main.js", "import { helper } from \"./lib/helper.js\";\nimport \"@space/db\";\nimport \"nanoid\";\nexport const main = helper;\n");
    await write("apps/api/dist/lib/helper.js", "export const helper = 1;\n");
    await write("apps/api/dist/server.js", "import \"@temporalio/client\";\nimport \"pdfjs-dist/legacy/build/pdf.mjs\";\n");
    await write("apps/web/package.json", pkg("@space/web"));
    await write("apps/web/server.mjs", "export const web = 1;\n");
    await write("apps/web/dist/index.html", "<p>web</p>\n");
    await write("packages/db/package.json", pkg("@space/db", { pg: "8.0.0" }));
    await write("packages/db/dist/index.js", "export const db = 1;\n");
    await write("packages/db/dist/migrate.js", "export const migrate = 1;\n");
    await write("packages/db/migrations/0001_initial.sql", "SELECT 1;\n");
    await write("packages/cli-host/package.json", pkg("@space/cli-host", { "node-pty": "1.1.0" }));
    await write("packages/cli-host/dist/main.js", "export const main = 1;\n");
    await write("packages/cli-host/dist/index.d.ts", "export {};\n");
    await write("agent-skills/demo/SKILL.md", "# demo\n");
    await write("scripts/portable-backup.mjs", "export {};\n");
    await write("scripts/reset-owner-password.mjs", "export {};\n");
    for (const ws of [
      "apps/worker", "packages/browser-host", "packages/codex-app-server", "packages/contracts",
      "packages/gateway", "packages/memory-graph", "packages/opencode-control", "packages/runtime", "packages/streaming"
    ]) {
      await write(`${ws}/package.json`, pkg(`@space/${ws.split("/")[1]}`));
      await write(`${ws}/dist/index.js`, "export {};\n");
    }
    await write("packages/gateway/grammars/tree-sitter-python.wasm", "wasm");
    await write("packages/gateway/src/providers/local/space-local-embeddings.py", "print('ok')\n");
    await write("node_modules/nanoid/package.json", pkg("nanoid"));
    await write("node_modules/nanoid/index.js", "export const id = 1;\n");
    await write("node_modules/pg/package.json", pkg("pg"));
    await write("node_modules/pg/index.js", "export const pg = 1;\n");
    await write("node_modules/pdfjs-dist/package.json", pkg("pdfjs-dist", {}, { "@napi-rs/canvas": "1.0.9" }));
    await write("node_modules/pdfjs-dist/legacy/build/pdf.mjs", "export const pdf = 1;\n");
    await write("node_modules/@napi-rs/canvas/package.json", pkg("@napi-rs/canvas", {}, {
      "@napi-rs/canvas-linux-x64-gnu": "1.0.9",
      "@napi-rs/canvas-linux-arm64-gnu": "1.0.9",
      "@napi-rs/canvas-darwin-arm64": "1.0.9",
      "@napi-rs/canvas-linux-x64-musl": "1.0.9"
    }));
    await write("node_modules/@napi-rs/canvas/index.js", "export {};\n");
    await write("node_modules/@napi-rs/canvas-linux-x64-gnu/package.json", pkg("@napi-rs/canvas-linux-x64-gnu"));
    await write("node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node", "linux-x64");
    await write("node_modules/@napi-rs/canvas-linux-arm64-gnu/package.json", pkg("@napi-rs/canvas-linux-arm64-gnu"));
    await write("node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node", "linux-arm64");
    await write("node_modules/@napi-rs/canvas-darwin-arm64/package.json", pkg("@napi-rs/canvas-darwin-arm64"));
    await write("node_modules/@napi-rs/canvas-darwin-arm64/skia.node", "darwin");
    await write("node_modules/@napi-rs/canvas-linux-x64-musl/package.json", pkg("@napi-rs/canvas-linux-x64-musl"));
    await write("node_modules/@napi-rs/canvas-linux-x64-musl/skia.node", "musl");
    await write("node_modules/@temporalio/client/package.json", pkg("@temporalio/client", { "@temporalio/core-bridge": "1.24.0" }));
    await write("node_modules/@temporalio/client/index.js", "export {};\n");
    await write("node_modules/@temporalio/core-bridge/package.json", pkg("@temporalio/core-bridge"));
    await write("node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/bridge.node", "amd64");
    await write("node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu/bridge.node", "arm64");
    await write("node_modules/@temporalio/core-bridge/releases/x86_64-apple-darwin/bridge.node", "darwin");
    await write("node_modules/@temporalio/core-bridge/sdk-core/lib.rs", "fn main() {}\n");
    await write("node_modules/node-pty/package.json", pkg("node-pty", { "node-addon-api": "7.0.0" }));
    await write("node_modules/node-pty/lib/index.js", "exports.spawn = () => {};\n");
    await write("node_modules/node-pty/lib/index.js.map", "map");
    await write("node_modules/node-pty/build/Release/pty.node", "pty");
    await write("node_modules/node-pty/build/Release/spawn-helper", "helper");
    await write("node_modules/node-pty/prebuilds/linux-x64/pty.node", "linux-x64");
    await write("node_modules/node-pty/prebuilds/linux-arm64/pty.node", "linux-arm64");
    await write("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "darwin");
    await write("node_modules/node-pty/third_party/conpty/OpenConsole.exe", "conpty");
    await write("node_modules/node-addon-api/package.json", pkg("node-addon-api"));
    await write("node_modules/node-addon-api/index.js", "exports.ok = 1;\n");

    assert.throws(
      () => stageAllContainerTargets({ sourceRoot: source, outputRoot: join(source, "inside"), arch: "amd64" }),
      /inside source/
    );

    stageAllContainerTargets({ sourceRoot: source, outputRoot: output, arch: "amd64" });
    const core = join(output, "core");
    const browser = join(output, "browser");
    const cli = join(output, "cli");
    const present = (path) => readFile(path, "utf8");
    const absent = async (path) => {
      await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    };

    await present(join(core, "packages/db/migrations/0001_initial.sql"));
    await present(join(core, "packages/db/dist/migrate.js"));
    await present(join(core, "apps/api/dist/server.js"));
    await present(join(core, "apps/web/server.mjs"));
    await present(join(core, "apps/web/dist/index.html"));
    await present(join(core, "scripts/portable-backup.mjs"));
    await present(join(core, "scripts/reset-owner-password.mjs"));
    await present(join(core, "agent-skills/demo/SKILL.md"));
    await present(join(core, "packages/gateway/grammars/tree-sitter-python.wasm"));
    await present(join(core, "packages/gateway/src/providers/local/space-local-embeddings.py"));
    await present(join(core, "node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/bridge.node"));
    await present(join(core, "node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node"));
    await present(join(core, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    await absent(join(core, "node_modules/node-pty/lib/index.js"));
    await absent(join(core, "node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu/bridge.node"));
    await absent(join(core, "node_modules/@temporalio/core-bridge/releases/x86_64-apple-darwin/bridge.node"));
    await absent(join(core, "node_modules/@temporalio/core-bridge/sdk-core/lib.rs"));
    await absent(join(core, "node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node"));
    await absent(join(core, "node_modules/@napi-rs/canvas-darwin-arm64/skia.node"));
    await absent(join(core, "node_modules/@napi-rs/canvas-linux-x64-musl/skia.node"));
    assert.match(await readlink(join(core, "node_modules/@space/db")), /\.\.\/\.\.\/packages\/db$/);

    await present(join(browser, "apps/api/dist/browser-host-main.js"));
    await present(join(browser, "apps/api/dist/lib/helper.js"));
    await present(join(browser, "node_modules/nanoid/index.js"));
    await present(join(browser, "node_modules/pg/index.js"));
    await present(join(browser, "packages/db/migrations/0001_initial.sql"));
    await absent(join(browser, "apps/api/dist/server.js"));
    await absent(join(browser, "node_modules/@temporalio/client/index.js"));
    await absent(join(browser, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    await absent(join(browser, "node_modules/node-pty/lib/index.js"));
    await absent(join(browser, "apps/web/server.mjs"));

    await present(join(cli, "packages/cli-host/dist/main.js"));
    await present(join(cli, "node_modules/node-pty/build/Release/pty.node"));
    await present(join(cli, "node_modules/node-pty/build/Release/spawn-helper"));
    await present(join(cli, "node_modules/node-pty/prebuilds/linux-x64/pty.node"));
    await present(join(cli, "node_modules/node-pty/lib/index.js"));
    await present(join(cli, "node_modules/node-addon-api/index.js"));
    await present(join(cli, "agent-skills/demo/SKILL.md"));
    await absent(join(cli, "packages/cli-host/dist/index.d.ts"));
    await absent(join(cli, "node_modules/node-pty/lib/index.js.map"));
    await absent(join(cli, "node_modules/node-pty/prebuilds/linux-arm64/pty.node"));
    await absent(join(cli, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"));
    await absent(join(cli, "node_modules/node-pty/third_party/conpty/OpenConsole.exe"));
    await absent(join(cli, "apps/api/dist/server.js"));
    await absent(join(cli, "node_modules/@temporalio/client/index.js"));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("container smoke plans follow each image entrypoint", async () => {
  const { buildSmokePlan, parseSmokeArgs, runContainerSmoke, CLI_HOST_SOCKET, BROWSER_HOST_SOCKET, CHROMIUM_PROBE } = await import(
    pathToFileURL(join(root, "deploy/docker/smoke-container-image.mjs")).href
  );

  assert.deepEqual(
    parseSmokeArgs(["--target", "core", "--image", "spaceapp-ci:core-amd64", "--arch", "amd64"]),
    { target: "core", image: "spaceapp-ci:core-amd64", arch: "amd64" }
  );
  assert.throws(() => parseSmokeArgs(["--target", "desktop", "--image", "x"]), /Unsupported container target/);

  const corePlan = buildSmokePlan({ target: "core", image: "spaceapp-ci:core-amd64", arch: "amd64", runId: "t1", secretDir: "/secrets" });
  assert.equal(corePlan.requiresPostgres, true);
  assert.equal(corePlan.migrateArgs, null);
  assert.match(corePlan.readinessProbe, /http:\/\/127\.0\.0\.1:4911\/readyz/);
  assert.equal(corePlan.containerEnv.SPACE_RUNTIME_STORE, "postgres");
  assert.equal(corePlan.containerEnv.SPACEAPP_WORKFLOWS_ENABLED, "false");
  assert.ok(corePlan.secretMounts.some((mount) => mount.startsWith("/secrets/database-url:/run/secrets/database-url")));
  assert.ok(corePlan.secretMounts.some((mount) => mount.includes("/run/secrets/setup-token")));
  assert.equal(corePlan.runArgs.at(-1), "spaceapp-ci:core-amd64");

  const cliPlan = buildSmokePlan({ target: "cli", image: "spaceapp-ci:cli-arm64", arch: "arm64", runId: "t2" });
  assert.equal(cliPlan.requiresPostgres, false);
  assert.equal(cliPlan.containerEnv.SPACE_CLI_HOST_SOCKET, CLI_HOST_SOCKET);
  assert.match(cliPlan.socketProbe, /\/run\/spaceapp-cli\/host\.sock/);
  assert.equal(cliPlan.runArgs.at(-1), "spaceapp-ci:cli-arm64");

  const browserPlan = buildSmokePlan({ target: "browser", image: "spaceapp-ci:browser-amd64", arch: "amd64", runId: "t3", secretDir: "/secrets" });
  assert.equal(browserPlan.requiresPostgres, true);
  assert.equal(browserPlan.containerEnv.SPACE_BROWSER_HOST_SOCKET, BROWSER_HOST_SOCKET);
  assert.ok(browserPlan.migrateArgs.includes("packages/db/dist/migrate.js"));
  assert.deepEqual(browserPlan.chromiumProbe, CHROMIUM_PROBE);

  const calls = [];
  const result = await runContainerSmoke(
    { target: "cli", image: "spaceapp-ci:cli-amd64", arch: "amd64" },
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: "running\n", stderr: "" };
    }
  );
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call[1] === "run" && call.includes("spaceapp-ci:cli-amd64")));
  assert.ok(calls.some((call) => call.includes(`SPACE_CLI_HOST_SOCKET=${CLI_HOST_SOCKET}`)));
  assert.ok(calls.some((call) => call[1] === "exec" && call.includes("node")));
});
