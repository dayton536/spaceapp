import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  composeCommand,
  composeFileForEngine,
  createDefaultConfig,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";
import {
  ensureDockerAvailable,
  ensurePodmanAvailable,
  parsePodmanMajorVersion,
  podmanMachineResizeAdvice,
  podmanMachineResources
} from "../src/prerequisites.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

const GIB = 1024 ** 3;
const abundantResources = async () => ({
  cpuCount: 8,
  totalMemoryBytes: 16 * GIB,
  freeDiskBytes: 64 * GIB
});

function createIo(input = "") {
  const stdin = new PassThrough();
  stdin.end(input);
  let out = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    }
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      err += String(chunk);
      cb();
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    get out() { return out; },
    get err() { return err; }
  };
}

function createPodmanInfoJson({
  rootless = true,
  cgroupVersion = "v2",
  cgroupControllers = ["cpu", "memory", "pids"],
  cpus = 8,
  memTotal = 16 * GIB,
  graphRoot = "/home/user/.local/share/containers/storage",
  arch = "amd64",
  version = "5.3.1"
} = {}) {
  return JSON.stringify({
    host: {
      arch,
      cpus,
      memTotal,
      cgroupVersion,
      cgroupControllers,
      security: { rootless }
    },
    store: {
      graphRoot
    },
    version: {
      Version: version
    }
  });
}

test("parsePodmanMajorVersion extracts major version and ensurePodmanAvailable rejects Podman 4.x", async () => {
  assert.equal(parsePodmanMajorVersion("podman version 5.3.1"), 5);
  assert.equal(parsePodmanMajorVersion("podman version 4.9.4-rhel"), 4);
  assert.equal(parsePodmanMajorVersion(""), null);

  const io = createIo();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    execute: async (spec) => {
      if (spec.command === "podman" && spec.args[0] === "--version") {
        spec.onStdout?.("podman version 4.9.3\n");
        return 0;
      }
      if (spec.command === "podman" && spec.args[0] === "compose") return 0;
      if (spec.command === "podman" && spec.args[0] === "info") {
        spec.onStdout?.(createPodmanInfoJson({ version: "4.9.3" }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(result.code, 1);
  assert.match(io.err, /requires Podman 5\.0 or newer/i);
});

test("ensureDockerAvailable auto-detects and offers Podman 5+ when Docker CLI is absent", async () => {
  const io = createIo("y\n");
  Object.defineProperty(io.stdin, "isTTY", { value: true });
  const result = await ensureDockerAvailable({
    platform: "linux",
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    execute: async (spec) => {
      if (spec.command === "docker") return 127;
      if (spec.command === "podman" && spec.args[0] === "--version") {
        spec.onStdout?.("podman version 5.2.0\n");
        return 0;
      }
      if (spec.command === "podman" && spec.args[0] === "compose") return 0;
      if (spec.command === "podman" && spec.args[0] === "info") {
        spec.onStdout?.(createPodmanInfoJson({ version: "5.2.0", rootless: true }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(result.code, 0);
  assert.equal(result.engine, "podman");
  assert.match(io.out, /Using Podman as the container engine/i);
});

test("renderWorkspaceCompose adds SELinux :z label and keep-id userns_mode for Podman", () => {
  const config = {
    ...createDefaultConfig({
      version: "1.1.7",
      engine: "podman"
    }),
    users: [
      {
        id: "user:Alice",
        workspaces: [
          { id: "team-a-abcdef12", hostPath: "/home/dev/team-a", containerPath: "/workspaces/team-a-abcdef12", readOnly: true }
        ]
      }
    ],
    workspaces: [
      { id: "repo-12345678", hostPath: "/home/dev/repo", containerPath: "/workspaces/repo-12345678", readOnly: false }
    ]
  };
  validateConfig(config);
  assert.equal(config.engine, "podman");

  const rendered = renderWorkspaceCompose(config);
  assert.match(rendered, /selinux: z/);
  assert.match(rendered, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(rendered, /spaceapp-cli-alice-[a-f0-9]+:/);
  assert.doesNotMatch(rendered, /no-new-privileges/);
});

test("validateConfig and prepareInstallation refuse --access host-root when engine is podman", async () => {
  assert.throws(
    () => validateConfig(createDefaultConfig({ version: "1.1.7", engine: "podman", accessMode: "host-root" })),
    /Host-root access \(--access host-root\) is not supported on Podman/i
  );

  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  try {
    await assert.rejects(
      () => prepareInstallation(root, { version: "1.1.7", engine: "podman", accessMode: "host-root" }),
      /Host-root access \(--access host-root\) is not supported on Podman/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composeCommand uses podman compose when engine is podman across lifecycle actions", () => {
  const root = "/tmp/spaceapp-podman";
  for (const action of ["pull", "up", "down", "status", "logs", "backup", "restore", "purge", "syncWorkspaces"]) {
    const cmd = composeCommand(action, root, {
      profile: "small",
      engine: "podman",
      backupId: "spaceapp-backup-20261027T000000000Z"
    });
    assert.equal(cmd.command, "podman", `Expected podman command for action ${action}`);
    assert.equal(cmd.args[0], "compose");
  }
});

test("inspectStoragePlan queries podman info and podman image inspect when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  try {
    const config = createDefaultConfig({ version: "1.1.7", engine: "podman", profile: "small" });
    const seen = [];
    const plan = await inspectStoragePlan({
      root,
      config,
      operation: "fresh",
      resources: { cpuCount: 8, totalMemoryBytes: 16 * GIB, freeDiskBytes: 64 * GIB },
      execute: async (spec, io) => {
        seen.push(`${spec.command} ${spec.args.join(" ")}`);
        if (spec.command === "podman" && spec.args[0] === "info") {
          const json = createPodmanInfoJson();
          spec.onStdout?.(json);
          io?.stdout?.write?.(json);
          return 0;
        }
        if (spec.command === "podman" && spec.args[0] === "image" && spec.args[1] === "inspect") {
          const id = "a".repeat(64) + "\n";
          spec.onStdout?.(id);
          io?.stdout?.write?.(id);
          return 0;
        }
        if (spec.command === "podman" && spec.args[0] === "system" && spec.args[1] === "df") {
          const df = '{"Type":"Images","Size":"2.1GB"}\n';
          spec.onStdout?.(df);
          io?.stdout?.write?.(df);
          return 0;
        }
        return 0;
      }
    });
    assert.equal(plan.resources.engineCpuCount, 8);
    assert.ok(seen.some((cmd) => cmd.startsWith("podman info")));
    assert.ok(seen.some((cmd) => cmd.startsWith("podman image inspect")));
    assert.ok(!seen.some((cmd) => cmd.startsWith("docker ")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI install --engine podman, workspace add, lifecycle commands, doctor, and support-bundle use Podman end-to-end", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-e2e-"));
  const wsDir = join(root, "my-project");
  const answersPath = join(root, "answers.json");
  await mkdir(wsDir, { recursive: true });
  await writeFile(answersPath, JSON.stringify({
    profile: "small",
    access: "isolated",
    companions: false,
    telemetry: false,
    open: false,
    confirm: true
  }), "utf8");
  const testEnv = { ...process.env, SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" };
  try {
    const commands = [];
    const podmanExecute = async (spec, io) => {
      commands.push(`${spec.command} ${spec.args.join(" ")}`);
      if (spec.command === "podman" && spec.args[0] === "--version") {
        spec.onStdout?.("podman version 5.3.1\n");
        io?.stdout?.write?.("podman version 5.3.1\n");
        return 0;
      }
      if (spec.command === "podman" && spec.args[0] === "compose" && spec.args[1] === "version") {
        spec.onStdout?.("podman-compose version 1.2.0\n");
        io?.stdout?.write?.("podman-compose version 1.2.0\n");
        return 0;
      }
      if (spec.command === "podman" && spec.args[0] === "info") {
        const json = createPodmanInfoJson({
          rootless: true,
          cgroupVersion: "v2",
          cgroupControllers: ["cpu", "pids"] // memory omitted to test cgroup delegation warning
        });
        spec.onStdout?.(json);
        io?.stdout?.write?.(json);
        return 0;
      }
      if (spec.command === "podman" && spec.args.includes("owner-setup-token")) {
        const tok = "setup-token-podman-1234567890abcdef123456\n";
        spec.onStdout?.(tok);
        io?.stdout?.write?.(tok);
        return 0;
      }
      return 0;
    };

    const installIo = createIo();
    const installCode = await run(["--non-interactive", "--answers", answersPath, "install", "--engine", "podman", "--profile", "small", "--no-open"], {
      env: testEnv,
      platform: "linux",
      stdin: installIo.stdin,
      stdout: installIo.stdout,
      stderr: installIo.stderr,
      inspectResources: abundantResources,
      execute: podmanExecute,
      request: async () => new Response(JSON.stringify({ ok: true, setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } }),
      sleep: async () => {}
    });
    assert.equal(installCode, 0, installIo.err);
    const savedConfig = await loadConfig(root);
    assert.equal(savedConfig.engine, "podman");
    assert.ok(commands.every((cmd) => !cmd.startsWith("docker ")), `Unexpected docker command: ${commands.join(", ")}`);
    assert.ok(commands.some((cmd) => cmd.startsWith("podman compose ")));
    assert.match(installIo.out, /cgroup v2.*memory/i);

    // Workspace add should render SELinux :z and keep-id and skip sudo setfacl hint on rootless Podman
    const wsIo = createIo();
    const wsCode = await run(["workspace", "add", wsDir], {
      env: testEnv,
      platform: "linux",
      stdin: wsIo.stdin,
      stdout: wsIo.stdout,
      stderr: wsIo.stderr,
      execute: podmanExecute
    });
    assert.equal(wsCode, 0, wsIo.err);
    assert.doesNotMatch(wsIo.out, /sudo setfacl/);

    // Doctor should report Podman CLI, Podman Compose, and Podman Engine (rootless + cgroup v2 warning)
    const doctorIo = createIo();
    const doctorCode = await run(["doctor"], {
      env: testEnv,
      platform: "linux",
      stdin: doctorIo.stdin,
      stdout: doctorIo.stdout,
      stderr: doctorIo.stderr,
      inspectResources: abundantResources,
      execute: podmanExecute
    });
    assert.equal(doctorCode, 0, doctorIo.err);
    assert.match(doctorIo.out, /PASS Podman CLI: available \(5\.3\.1\)/);
    assert.match(doctorIo.out, /PASS Podman Compose: available/);
    assert.match(doctorIo.out, /PASS Podman Engine: available \(rootless, warning: cgroup v2 cpu\/memory controllers not delegated\)/);

    // Support bundle should record engine: "podman" and rootless status
    const bundlePath = join(root, "bundle.json");
    const bundleIo = createIo();
    const bundleCode = await run(["support-bundle", "--output", bundlePath], {
      env: testEnv,
      platform: "linux",
      stdin: bundleIo.stdin,
      stdout: bundleIo.stdout,
      stderr: bundleIo.stderr,
      inspectResources: abundantResources,
      execute: podmanExecute,
      request: async () => new Response(JSON.stringify({ ok: true, setupRequired: false, expiresAt: "2099-07-23T12:15:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } })
    });
    assert.equal(bundleCode, 0, bundleIo.err);
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    assert.equal(bundle.installation.config.engine, "podman");
    assert.equal(bundle.engine.type, "podman");
    assert.equal(bundle.engine.rootless, true);
    assert.equal(bundle.engine.cgroupVersion, "v2");
    assert.equal(bundle.engine.cgroupDelegated, false);
    assert.equal(bundle.engine.majorVersion, 5);

    // Switching engines on an existing installation via install --engine docker or reinstall --engine docker is refused
    const switchInstallIo = createIo();
    const switchInstallCode = await run(["install", "--engine", "docker", "--no-open"], {
      env: testEnv,
      platform: "linux",
      stdin: switchInstallIo.stdin,
      stdout: switchInstallIo.stdout,
      stderr: switchInstallIo.stderr,
      inspectResources: abundantResources,
      execute: podmanExecute
    });
    assert.equal(switchInstallCode, 1);
    assert.match(switchInstallIo.err, /Switching container engines on an existing installation \(podman -> docker\) is refused/i);

    const switchReinstallIo = createIo();
    const switchReinstallCode = await run(["reinstall", "--engine", "docker"], {
      env: testEnv,
      platform: "linux",
      stdin: switchReinstallIo.stdin,
      stdout: switchReinstallIo.stdout,
      stderr: switchReinstallIo.stderr,
      inspectResources: abundantResources,
      execute: podmanExecute
    });
    assert.equal(switchReinstallCode, 1);
    assert.match(switchReinstallIo.err, /Switching container engines on an existing installation \(podman -> docker\) is refused/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composeFileForEngine drops no-new-privileges only on the Podman CLI service", async () => {
  const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
  assert.equal(composeFileForEngine(template, "docker"), template);
  const podmanTemplate = composeFileForEngine(template, "podman");
  const cliSection = podmanTemplate.split("  codex-sessions-init:")[0].split("  spaceapp-cli:")[1];
  assert.doesNotMatch(cliSection, /no-new-privileges/);
  assert.match(podmanTemplate, /no-new-privileges:true/);
  assert.match(podmanTemplate, /gosu/);
});

test("podman machine inspect values and profile resize advice", () => {
  const bytes = podmanMachineResources({ Resources: { CPUs: 2, Memory: 4 * GIB, DiskSize: 20 * GIB, }, State: "running" });
  assert.equal(bytes.cpuCount, 2);
  assert.equal(bytes.memoryBytes, 4 * GIB);
  assert.equal(bytes.diskBytes, 20 * GIB);
  const units = podmanMachineResources([{ Resources: { CPUs: 8, Memory: 8192, DiskSize: 30 } }]);
  assert.equal(units.memoryBytes, 8192 * 1024 ** 2);
  assert.equal(units.diskBytes, 30 * GIB);
  const advice = podmanMachineResizeAdvice(bytes, "small");
  assert.match(advice, /too small for the small profile/);
  assert.match(advice, /podman machine set --cpus 4 --memory \d+/);
  assert.doesNotMatch(advice, /--disk-size/);
  assert.equal(podmanMachineResizeAdvice(units, "small"), null);
});

test("ensurePodmanAvailable refuses Windows and an undersized macOS Podman machine", async () => {
  const windows = createIo();
  const refused = await ensurePodmanAvailable({
    platform: "win32",
    stdout: windows.stdout,
    stderr: windows.stderr,
    execute: async () => 0
  });
  assert.equal(refused.code, 1);
  assert.match(windows.err, /not supported on Windows/i);

  const mac = createIo();
  const result = await ensurePodmanAvailable({
    platform: "darwin",
    stdout: mac.stdout,
    stderr: mac.stderr,
    installArgs: { requestedProfile: "large" },
    execute: async (spec) => {
      if (spec.args?.[0] === "--version") {
        spec.onStdout?.("podman version 5.4.0\n");
        return 0;
      }
      if (spec.args?.[0] === "compose") return 0;
      if (spec.args?.[0] === "info") {
        spec.onStdout?.(createPodmanInfoJson({ cpus: 8, memTotal: 16 * GIB, version: "5.4.0" }));
        return 0;
      }
      if (spec.args?.[0] === "machine") {
        spec.onStdout?.(JSON.stringify([{ Resources: { CPUs: 4, Memory: 8192, DiskSize: 10 } }]));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(result.code, 1);
  assert.match(mac.err, /too small for the large profile/);
  assert.match(mac.err, /--cpus 8/);
  assert.match(mac.err, /--disk-size/);
});

test("install accepts engine podman from --answers when Docker is also available", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-answers-"));
  const answersPath = join(root, "answers.json");
  await writeFile(answersPath, JSON.stringify({
    engine: "podman",
    profile: "small",
    access: "isolated",
    companions: false,
    telemetry: false,
    open: false,
    confirm: true
  }), "utf8");
  const commands = [];
  try {
    const io = createIo();
    const code = await run(["--non-interactive", "--answers", answersPath, "install", "--profile", "small", "--no-open"], {
      env: { ...process.env, SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
      platform: "linux",
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      inspectResources: abundantResources,
      execute: async (spec, execIo) => {
        commands.push(spec.command);
        if (spec.command === "docker") return 0;
        if (spec.command === "podman" && spec.args[0] === "--version") {
          spec.onStdout?.("podman version 5.3.1\n");
          execIo?.stdout?.write?.("podman version 5.3.1\n");
          return 0;
        }
        if (spec.command === "podman" && spec.args[0] === "info") {
          const json = createPodmanInfoJson();
          spec.onStdout?.(json);
          execIo?.stdout?.write?.(json);
          return 0;
        }
        return 0;
      },
      request: async () => new Response(JSON.stringify({ ok: true, setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } }),
      sleep: async () => {}
    });
    assert.equal(code, 0, io.err);
    assert.equal((await loadConfig(root)).engine, "podman");
    assert.equal(commands.includes("docker"), false);
    assert.equal(commands.includes("podman"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
