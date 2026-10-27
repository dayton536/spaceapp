#!/usr/bin/env node
// Stages the runtime tree each container target actually starts.
// The build stage runs this after `npm run build` and `npm prune --omit=dev`.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "sqlite", "stream", "string_decoder", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"
]);

// Workspaces the core entrypoint and supervisor load (API, worker, and the
// packages they import). The web UI is a prebuilt static tree, copied separately.
export const CORE_RUNTIME_WORKSPACES = [
  "apps/api",
  "apps/worker",
  "packages/browser-host",
  "packages/cli-host",
  "packages/codex-app-server",
  "packages/contracts",
  "packages/db",
  "packages/gateway",
  "packages/memory-graph",
  "packages/opencode-control",
  "packages/runtime",
  "packages/streaming"
];

// Owner and backup commands the launcher execs inside spaceapp-core, plus the
// proof-room fixture the API imports from the image.
export const CORE_RUNTIME_SCRIPTS = [
  "scripts/reset-owner-password.mjs",
  "scripts/rotate-owner-setup-token.mjs",
  "scripts/portable-backup.mjs",
  "scripts/portable-restore.mjs",
  "scripts/cli-render-fixture.mjs"
];

const WORKSPACE_RUNTIME_ASSETS = {
  "packages/db": ["migrations"],
  "packages/gateway": ["grammars", "src/providers/local/space-local-embeddings.py"]
};

export function normalizeTargetArch(arch = process.arch) {
  const normalized = String(arch || process.arch).trim().toLowerCase();
  if (normalized === "amd64" || normalized === "x64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  throw new Error(`Unsupported container target architecture: ${String(arch)}`);
}

export function shouldKeepOptionalPackage(packageName, targetArch) {
  const name = String(packageName).toLowerCase();
  const platformSpecific = /(darwin|win32|windows|android|freebsd|openbsd|sunos|linux-|musl|gnueabihf|riscv|arm64|aarch64|x86_64|-x64\b)/.test(name);
  if (!platformSpecific) return true;
  if (/(darwin|win32|windows|android|freebsd|openbsd|sunos|musl|gnueabihf|riscv)/.test(name)) return false;
  const arm = name.includes("arm64") || name.includes("aarch64");
  const x64 = name.includes("x64") || name.includes("x86_64") || name.includes("amd64");
  if (/-arm(?!64)/.test(name) && !arm) return false;
  if (targetArch === "amd64" && arm && !x64) return false;
  if (targetArch === "arm64" && x64 && !arm) return false;
  return true;
}

function prebuildDirAllowed(name, targetArch) {
  const match = /^(darwin|win32|linux|android|freebsd|openbsd)-(x64|arm64|ia32|arm)(?:-(musl|gnu))?$/.exec(name);
  if (!match) return true;
  const [, platform, arch, libc] = match;
  if (platform !== "linux" || libc === "musl") return false;
  return targetArch === "amd64" ? arch === "x64" : arch === "arm64";
}

function temporalReleaseAllowed(name, targetArch) {
  return targetArch === "amd64"
    ? name === "x86_64-unknown-linux-gnu"
    : name === "aarch64-unknown-linux-gnu";
}

// Drops declaration files, source maps, foreign-platform native builds, and the
// Temporal Rust sources. Linux node-pty is compiled into build/Release by npm ci
// (the published tarball has no linux prebuild), so that directory stays.
export function shouldKeepRuntimePath(relativePath, isDirectory, targetArch) {
  const normalized = relativePath.replaceAll("\\", "/");
  const name = basename(normalized);
  if (!isDirectory) {
    if (/\.(?:map|pdb)$/.test(name) || /\.d\.[cm]?ts$/.test(name)) return false;
    if (/\.(?:test|spec)\.(?:js|mjs|cjs)$/.test(name)) return false;
  }
  if (/(?:^|\/)node-pty\/(?:third_party|deps|src)(?:\/|$)/.test(normalized)) return false;
  if (/@temporalio\/core-bridge\/(?:sdk-core|src)(?:\/|$)/.test(normalized)) return false;
  const prebuild = normalized.match(/\/prebuilds\/([^/]+)$/);
  if (isDirectory && prebuild && !prebuildDirAllowed(prebuild[1], targetArch)) return false;
  const release = normalized.match(/@temporalio\/core-bridge\/releases\/([^/]+)$/);
  if (isDirectory && release && !temporalReleaseAllowed(release[1], targetArch)) return false;
  return true;
}

function barePackageName(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const base = specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  if (!base || NODE_BUILTINS.has(base)) return null;
  return base;
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function resolveLocalFile(fromFile, specifier, distRoot) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (!/\.(?:js|mjs|cjs|json|node)$/.test(base)) {
    candidates.push(`${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, join(base, "index.js"));
  }
  for (const candidate of candidates) {
    if (!isInside(distRoot, candidate) || !existsSync(candidate)) continue;
    if (lstatSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function traceLocalAndExternalImports(entryFile, distRoot) {
  const resolvedDistRoot = resolve(distRoot);
  const visitedFiles = new Set();
  const externalPackages = new Set();
  const queue = [resolve(entryFile)];
  const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

  while (queue.length > 0) {
    const currentFile = queue.shift();
    if (!currentFile || visitedFiles.has(currentFile) || !existsSync(currentFile)) continue;
    visitedFiles.add(currentFile);
    const source = stripComments(readFileSync(currentFile, "utf8"));
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const local = resolveLocalFile(currentFile, specifier, resolvedDistRoot);
        if (local) queue.push(local);
      } else {
        const pkg = barePackageName(specifier);
        if (pkg) externalPackages.add(pkg);
      }
    }
  }

  return {
    localFiles: [...visitedFiles].map((file) => relative(resolvedDistRoot, file)).sort(),
    externalPackages: [...externalPackages].sort()
  };
}

function readManifest(dir) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function productionDependencyNames(manifest) {
  if (!manifest) return [];
  return Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) });
}

function resolvePackageDirectory(startDir, sourceRoot, packageName) {
  let current = resolve(startDir);
  const root = resolve(sourceRoot);
  while (isInside(root, current)) {
    const candidate = join(current, "node_modules", packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function collectProductionModuleClosure({ sourceRoot, seedSpecs, excludePackages = new Set(), targetArch = "amd64" }) {
  const resolvedRoot = resolve(sourceRoot);
  const visited = new Map();
  const queue = [];
  for (const { fromDir, packageName } of seedSpecs) {
    if (excludePackages.has(packageName) || packageName.startsWith("@space/") || !shouldKeepOptionalPackage(packageName, targetArch)) {
      continue;
    }
    const pkgDir = resolvePackageDirectory(fromDir, resolvedRoot, packageName);
    if (pkgDir) queue.push(pkgDir);
  }

  while (queue.length > 0) {
    const pkgDir = queue.shift();
    const realDir = resolve(pkgDir);
    if (!isInside(resolvedRoot, realDir) || visited.has(realDir) || !existsSync(join(realDir, "package.json"))) continue;
    visited.set(realDir, relative(resolvedRoot, realDir).replaceAll("\\", "/"));
    for (const depName of productionDependencyNames(readManifest(realDir))) {
      if (excludePackages.has(depName) || depName.startsWith("@space/") || !shouldKeepOptionalPackage(depName, targetArch)) continue;
      const nextDir = resolvePackageDirectory(realDir, resolvedRoot, depName);
      if (nextDir) queue.push(nextDir);
    }
  }
  return [...visited.values()].sort();
}

function copyTree(src, dest, allow) {
  if (!existsSync(src)) return;
  const stat = lstatSync(src);
  const entry = { name: basename(src), isDirectory: () => stat.isDirectory() };
  if (allow && !allow(src, entry)) return;
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(src);
    if (isAbsolute(link)) return;
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(link, dest);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src, { withFileTypes: true })) {
      copyTree(join(src, child.name), join(dest, child.name), allow);
    }
    return;
  }
  if (stat.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

function runtimeFilter(sourceRoot, targetArch) {
  const root = resolve(sourceRoot);
  return (srcPath, entry) => {
    if (entry.name === "node_modules" && entry.isDirectory() && relative(root, srcPath).startsWith(`..`)) return false;
    const rel = relative(root, srcPath);
    if (!rel || rel.startsWith("..")) return true;
    return shouldKeepRuntimePath(rel, entry.isDirectory(), targetArch);
  };
}

function copyPackageClosure(sourceRoot, targetRoot, moduleRelativePaths, targetArch) {
  const allow = runtimeFilter(sourceRoot, targetArch);
  for (const relPath of moduleRelativePaths) {
    const src = join(sourceRoot, relPath);
    const dest = join(targetRoot, relPath);
    // npm usually materializes packages as real directories. If a package path is a
    // symlink, copy the directory it points at so the image does not keep a link
    // back into the build tree.
    if (existsSync(src) && lstatSync(src).isSymbolicLink()) {
      let realSrc;
      try {
        realSrc = realpathSync(src);
      } catch {
        continue;
      }
      if (!isInside(resolve(sourceRoot), realSrc)) continue;
      copyTree(realSrc, dest, allow);
      continue;
    }
    copyTree(src, dest, allow);
  }
}

function linkWorkspacePackages(targetRoot, workspaceDirs) {
  const scopeDir = join(targetRoot, "node_modules", "@space");
  mkdirSync(scopeDir, { recursive: true });
  for (const wsRel of workspaceDirs) {
    const manifest = readManifest(join(targetRoot, wsRel));
    if (!manifest?.name?.startsWith("@space/")) continue;
    const linkPath = join(scopeDir, manifest.name.slice("@space/".length));
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(relative(scopeDir, join(targetRoot, wsRel)), linkPath);
  }
}

function copyRootManifests(sourceRoot, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) {
    const src = join(sourceRoot, file);
    if (existsSync(src)) cpSync(src, join(targetRoot, file));
  }
}

function copyWorkspaceRuntime(sourceRoot, targetRoot, wsRel) {
  const srcWs = join(sourceRoot, wsRel);
  const destWs = join(targetRoot, wsRel);
  const manifestPath = join(srcWs, "package.json");
  if (!existsSync(manifestPath)) return false;
  mkdirSync(destWs, { recursive: true });
  cpSync(manifestPath, join(destWs, "package.json"));
  copyTree(join(srcWs, "dist"), join(destWs, "dist"), (_src, entry) => {
    if (entry.isDirectory()) return entry.name !== "__tests__" && entry.name !== "tests";
    return !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".map") && !entry.name.endsWith(".test.js");
  });
  for (const asset of WORKSPACE_RUNTIME_ASSETS[wsRel] ?? []) {
    copyTree(join(srcWs, asset), join(destWs, asset));
  }
  return true;
}

function copyScripts(sourceRoot, targetRoot, scriptRels) {
  for (const scriptRel of scriptRels) {
    const src = join(sourceRoot, scriptRel);
    if (!existsSync(src)) continue;
    const dest = join(targetRoot, scriptRel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

function dependencySeeds(sourceRoot, workspaceRels, excludePackages) {
  const seeds = [];
  for (const wsRel of workspaceRels) {
    const wsDir = join(sourceRoot, wsRel);
    for (const packageName of productionDependencyNames(readManifest(wsDir))) {
      if (excludePackages.has(packageName)) continue;
      seeds.push({ fromDir: wsDir, packageName });
    }
  }
  return seeds;
}

function assertOutputOutsideSource(sourceRoot, targetRoot) {
  if (isInside(resolve(sourceRoot), resolve(targetRoot))) {
    throw new Error(`Refusing to stage ${targetRoot} inside source tree ${sourceRoot}.`);
  }
}

export function stageCoreTarget(sourceRoot, targetRoot, targetArch) {
  assertOutputOutsideSource(sourceRoot, targetRoot);
  rmSync(targetRoot, { recursive: true, force: true });
  copyRootManifests(sourceRoot, targetRoot);
  const copied = [];
  for (const wsRel of CORE_RUNTIME_WORKSPACES) {
    if (copyWorkspaceRuntime(sourceRoot, targetRoot, wsRel)) copied.push(wsRel);
  }
  const webSrc = join(sourceRoot, "apps", "web");
  const webDest = join(targetRoot, "apps", "web");
  if (existsSync(join(webSrc, "server.mjs"))) {
    mkdirSync(webDest, { recursive: true });
    if (existsSync(join(webSrc, "package.json"))) cpSync(join(webSrc, "package.json"), join(webDest, "package.json"));
    cpSync(join(webSrc, "server.mjs"), join(webDest, "server.mjs"));
    copyTree(join(webSrc, "dist"), join(webDest, "dist"));
  }
  // The API serves built-in skills from /app/agent-skills. The CLI image gets its own copy.
  copyTree(join(sourceRoot, "agent-skills"), join(targetRoot, "agent-skills"), (_src, entry) => entry.name !== "node_modules");
  copyScripts(sourceRoot, targetRoot, CORE_RUNTIME_SCRIPTS);
  const excludePackages = new Set(["node-pty"]);
  const closure = collectProductionModuleClosure({
    sourceRoot,
    seedSpecs: dependencySeeds(sourceRoot, CORE_RUNTIME_WORKSPACES, excludePackages),
    excludePackages,
    targetArch
  });
  copyPackageClosure(sourceRoot, targetRoot, closure, targetArch);
  linkWorkspacePackages(targetRoot, copied);
  return { workspaces: copied, closureCount: closure.length };
}

export function stageBrowserTarget(sourceRoot, targetRoot, targetArch) {
  assertOutputOutsideSource(sourceRoot, targetRoot);
  rmSync(targetRoot, { recursive: true, force: true });
  copyRootManifests(sourceRoot, targetRoot);
  const apiDistRoot = join(sourceRoot, "apps", "api", "dist");
  const entryFile = join(apiDistRoot, "browser-host-main.js");
  const traced = existsSync(entryFile)
    ? traceLocalAndExternalImports(entryFile, apiDistRoot)
    : { localFiles: [], externalPackages: [] };
  const destApiDir = join(targetRoot, "apps", "api");
  if (existsSync(join(sourceRoot, "apps", "api", "package.json"))) {
    mkdirSync(join(destApiDir, "dist"), { recursive: true });
    cpSync(join(sourceRoot, "apps", "api", "package.json"), join(destApiDir, "package.json"));
    for (const relFile of traced.localFiles) {
      const destFile = join(destApiDir, "dist", relFile);
      mkdirSync(dirname(destFile), { recursive: true });
      cpSync(join(apiDistRoot, relFile), destFile);
    }
  }

  const spaceWorkspaces = [];
  const seedSpecs = [];
  const wsQueue = traced.externalPackages.filter((pkg) => pkg.startsWith("@space/"));
  for (const extPkg of traced.externalPackages) {
    if (!extPkg.startsWith("@space/")) seedSpecs.push({ fromDir: join(sourceRoot, "apps", "api"), packageName: extPkg });
  }
  const seen = new Set();
  while (wsQueue.length > 0) {
    const pkgName = wsQueue.shift();
    const wsRel = `packages/${pkgName.slice("@space/".length)}`;
    if (seen.has(wsRel)) continue;
    seen.add(wsRel);
    if (!copyWorkspaceRuntime(sourceRoot, targetRoot, wsRel)) continue;
    spaceWorkspaces.push(wsRel);
    for (const depName of productionDependencyNames(readManifest(join(sourceRoot, wsRel)))) {
      if (depName.startsWith("@space/")) wsQueue.push(depName);
      else seedSpecs.push({ fromDir: join(sourceRoot, wsRel), packageName: depName });
    }
  }
  const excludePackages = new Set(["node-pty"]);
  const closure = collectProductionModuleClosure({ sourceRoot, seedSpecs, excludePackages, targetArch });
  copyPackageClosure(sourceRoot, targetRoot, closure, targetArch);
  linkWorkspacePackages(targetRoot, spaceWorkspaces);
  return { localFiles: traced.localFiles, workspaces: spaceWorkspaces.sort(), closureCount: closure.length };
}

export function stageCliTarget(sourceRoot, targetRoot, targetArch) {
  assertOutputOutsideSource(sourceRoot, targetRoot);
  rmSync(targetRoot, { recursive: true, force: true });
  copyRootManifests(sourceRoot, targetRoot);
  const copied = copyWorkspaceRuntime(sourceRoot, targetRoot, "packages/cli-host") ? ["packages/cli-host"] : [];
  copyTree(join(sourceRoot, "agent-skills"), join(targetRoot, "agent-skills"), (_src, entry) => entry.name !== "node_modules");
  const cliDir = join(sourceRoot, "packages", "cli-host");
  const closure = collectProductionModuleClosure({
    sourceRoot,
    seedSpecs: dependencySeeds(sourceRoot, ["packages/cli-host"], new Set()),
    excludePackages: new Set(),
    targetArch
  });
  // cli-host's only production dependency is node-pty; still walk whatever the manifest declares.
  if (existsSync(cliDir)) {
    copyPackageClosure(sourceRoot, targetRoot, closure, targetArch);
  }
  linkWorkspacePackages(targetRoot, copied);
  return { workspaces: copied, closureCount: closure.length };
}

export function stageAllContainerTargets({ sourceRoot, outputRoot, arch = process.arch }) {
  const targetArch = normalizeTargetArch(arch);
  const resolvedSource = resolve(sourceRoot);
  const resolvedOutput = resolve(outputRoot);
  assertOutputOutsideSource(resolvedSource, resolvedOutput);
  mkdirSync(resolvedOutput, { recursive: true });
  return {
    arch: targetArch,
    core: stageCoreTarget(resolvedSource, join(resolvedOutput, "core"), targetArch),
    browser: stageBrowserTarget(resolvedSource, join(resolvedOutput, "browser"), targetArch),
    cli: stageCliTarget(resolvedSource, join(resolvedOutput, "cli"), targetArch)
  };
}

function parseCliArgs(argv) {
  let sourceRoot = process.cwd();
  let outputRoot = "/app-targets";
  let arch = process.env.TARGETARCH || process.arch;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      sourceRoot = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--output") {
      outputRoot = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--arch") {
      arch = argv[index + 1] || process.arch;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!sourceRoot || !outputRoot) throw new Error("Usage: stage-container-runtime.mjs --source <dir> --output <dir> [--arch amd64|arm64]");
  return { sourceRoot, outputRoot, arch };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const summary = stageAllContainerTargets(parseCliArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
