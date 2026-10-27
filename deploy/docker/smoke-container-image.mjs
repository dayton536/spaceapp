#!/usr/bin/env node
// Starts one built image the way its entrypoint runs in production and checks
// the signal that image is supposed to provide. Core and browser need the same
// secret files and pgvector database the Compose stack mounts; the CLI host
// only has to accept a connection on its socket.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same pgvector image the public Compose file runs, so migrations can create
// the vector extension. The digest is a multi-arch index.
export const SMOKE_POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";

export const CLI_HOST_SOCKET = "/run/spaceapp-cli/host.sock";
export const BROWSER_HOST_SOCKET = "/run/spaceapp-browser/browser-host.sock";

const READY_PROBE =
  "fetch('http://127.0.0.1:4911/readyz').then(async r=>{const b=await r.json();if(!r.ok||b.ok!==true)process.exit(1)}).catch(()=>process.exit(1))";

function socketProbe(socketPath) {
  return `import('node:net').then(({createConnection})=>{const s=createConnection(${JSON.stringify(socketPath)},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))})`;
}

export const CHROMIUM_PROBE = [
  "/usr/bin/chromium",
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--dump-dom",
  "about:blank"
];

export function parseSmokeArgs(argv) {
  let target = "";
  let image = "";
  let arch = "amd64";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      target = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--image") {
      image = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--arch") {
      arch = argv[index + 1] ?? "amd64";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["core", "browser", "cli"].includes(target)) {
    throw new Error(`Unsupported container target "${target}". Expected core, browser, or cli.`);
  }
  if (!image) throw new Error("Missing required --image <reference>.");
  if (!["amd64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported architecture "${arch}". Expected amd64 or arm64.`);
  }
  return { target, image, arch };
}

export function buildSmokePlan({ target, image, arch = "amd64", runId = "smoke", secretDir = "/tmp/spaceapp-smoke-secrets" }) {
  const platform = `linux/${arch}`;
  const networkName = `spaceapp-smoke-${target}-${arch}-${runId}`.replace(/[^a-z0-9_.-]/gi, "-").slice(0, 60);
  const pgContainer = `${networkName}-pg`.slice(0, 63);
  const targetContainer = `${networkName}-${target}`.slice(0, 63);
  const databaseUrl = `postgresql://spaceapp:spaceapp@${pgContainer}:5432/spaceapp`;
  const requiresPostgres = target !== "cli";
  const secretMounts = [];
  if (target === "core" || target === "browser") {
    secretMounts.push(`${secretDir}/database-url:/run/secrets/database-url:ro`);
  }
  if (target === "core") {
    secretMounts.push(`${secretDir}/session-secret:/run/secrets/session-secret:ro`);
    secretMounts.push(`${secretDir}/setup-token:/run/secrets/setup-token:ro`);
  }

  const containerEnv = {};
  if (target === "core") {
    Object.assign(containerEnv, {
      SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACEAPP_WORKFLOWS_ENABLED: "false",
      SPACE_RUNTIME_STORE: "postgres",
      SPACE_BROWSER_SESSIONS_ENABLED: "false",
      SPACE_DEV_LOGIN: "false",
      SPACE_AGENT_TOOLS_WRITER: "disabled"
    });
  } else if (target === "browser") {
    Object.assign(containerEnv, {
      SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACE_RUNTIME_STORE: "postgres",
      SPACE_DATABASE_URL_FILE: "/run/secrets/database-url",
      SPACE_BROWSER_HOST_SOCKET: BROWSER_HOST_SOCKET
    });
  } else {
    containerEnv.SPACE_CLI_HOST_SOCKET = CLI_HOST_SOCKET;
  }

  const envFlags = Object.entries(containerEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const mountFlags = secretMounts.flatMap((mount) => ["-v", mount]);
  const runArgs = [
    "run", "-d",
    "--name", targetContainer,
    "--platform", platform,
    ...(requiresPostgres ? ["--network", networkName] : []),
    ...mountFlags,
    ...envFlags,
    image
  ];

  return {
    target,
    image,
    arch,
    platform,
    networkName,
    pgContainer: requiresPostgres ? pgContainer : null,
    targetContainer,
    requiresPostgres,
    databaseUrl: requiresPostgres ? databaseUrl : null,
    postgresImage: SMOKE_POSTGRES_IMAGE,
    secretMounts,
    containerEnv,
    // Core's entrypoint applies packages/db migrations before the supervisor.
    // Browser has no migration entrypoint, so the smoke runs migrate.js first.
    migrateArgs: target === "browser"
      ? ["run", "--rm", "--platform", platform, "--network", networkName, "-e", `SPACE_DATABASE_URL=${databaseUrl}`, "--entrypoint", "node", image, "packages/db/dist/migrate.js"]
      : null,
    runArgs,
    readinessProbe: target === "core" ? READY_PROBE : null,
    socketProbe: target === "cli" ? socketProbe(CLI_HOST_SOCKET) : target === "browser" ? socketProbe(BROWSER_HOST_SOCKET) : null,
    chromiumProbe: target === "browser" ? CHROMIUM_PROBE : null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(fn, { attempts, delayMs, description }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for ${description}: ${message}`);
}

async function containerLogs(execImpl, name) {
  try {
    const { stdout, stderr } = await execImpl("docker", ["logs", "--tail", "120", name], { timeout: 20_000 });
    return `${stdout ?? ""}${stderr ?? ""}`.trim();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runContainerSmoke(options, execImpl = execFileAsync) {
  const secretDir = await mkdtemp(join(tmpdir(), "spaceapp-smoke-"));
  const plan = buildSmokePlan({ ...options, secretDir, runId: `${process.pid}-${Date.now()}` });
  const databaseUrl = plan.databaseUrl ?? "";
  await writeFile(join(secretDir, "database-url"), databaseUrl);
  // The core entrypoint rejects a setup token shorter than 32 characters and a session secret shorter than 16.
  await writeFile(join(secretDir, "session-secret"), "smoke-test-session-secret-0123456789abcdef");
  await writeFile(join(secretDir, "setup-token"), "smoke-test-setup-token-0123456789abcdef");

  try {
    if (plan.requiresPostgres) {
      await execImpl("docker", ["network", "create", plan.networkName]);
      await execImpl("docker", [
        "run", "-d",
        "--name", plan.pgContainer,
        "--platform", plan.platform,
        "--network", plan.networkName,
        "-e", "POSTGRES_USER=spaceapp",
        "-e", "POSTGRES_PASSWORD=spaceapp",
        "-e", "POSTGRES_DB=spaceapp",
        plan.postgresImage
      ]);
      await pollUntil(
        () => execImpl("docker", ["exec", plan.pgContainer, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"]),
        { attempts: 40, delayMs: 1_000, description: "PostgreSQL readiness" }
      );
      if (plan.migrateArgs) {
        await execImpl("docker", plan.migrateArgs, { timeout: 180_000 });
      }
    }

    await execImpl("docker", plan.runArgs);
    const probe = plan.readinessProbe ?? plan.socketProbe;
    const description = plan.target === "core"
      ? "core /readyz ok:true"
      : plan.target === "cli"
        ? "cli host socket connection"
        : "browser host socket connection";
    try {
      await pollUntil(
        async () => {
          const state = await execImpl("docker", ["inspect", "--format", "{{.State.Status}}", plan.targetContainer]);
          const status = `${state.stdout ?? ""}`.trim();
          if (status && status !== "running") {
            throw new Error(`container status is ${status}`);
          }
          await execImpl("docker", ["exec", plan.targetContainer, "node", "-e", probe]);
        },
        {
          attempts: plan.target === "core" ? 90 : 40,
          delayMs: plan.target === "core" ? 3_000 : 1_000,
          description
        }
      );
    } catch (error) {
      const logs = await containerLogs(execImpl, plan.targetContainer);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n--- ${plan.targetContainer} logs ---\n${logs}`);
    }

    if (plan.chromiumProbe) {
      await execImpl("docker", ["exec", plan.targetContainer, ...plan.chromiumProbe], { timeout: 180_000 });
    }
    return { ok: true, target: plan.target, image: plan.image, arch: options.arch };
  } finally {
    await execImpl("docker", ["rm", "-f", plan.targetContainer]).catch(() => {});
    if (plan.pgContainer) await execImpl("docker", ["rm", "-f", plan.pgContainer]).catch(() => {});
    if (plan.requiresPostgres) await execImpl("docker", ["network", "rm", plan.networkName]).catch(() => {});
    await rm(secretDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = parseSmokeArgs(process.argv.slice(2));
  try {
    const result = await runContainerSmoke(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
