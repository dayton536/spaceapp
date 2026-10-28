#!/usr/bin/env node
// Checks this checkout against PUBLIC_EXPORT_MANIFEST.json without access to the private tree:
// every exported file must match the manifest's SHA-256 and size; a file whose bytes still hash to
// the recorded private git blob id was exported unchanged, any other file was sanitized.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function blobId(buffer, recorded) {
  return createHash(recorded.length === 64 ? "sha256" : "sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

export async function verifyExportProvenance(root) {
  const manifest = JSON.parse(await readFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
  const result = { sourceCommit: manifest.sourceCommit, files: manifest.files.length, unchanged: 0, sanitized: [], problems: [] };
  for (const file of manifest.files) {
    let buffer;
    try { buffer = await readFile(join(root, file.path)); } catch { result.problems.push(`missing: ${file.path}`); continue; }
    if (buffer.length !== file.size || createHash("sha256").update(buffer).digest("hex") !== file.sha256) {
      result.problems.push(`differs from the manifest: ${file.path}`);
    } else if (blobId(buffer, file.sourceObjectId) === file.sourceObjectId) {
      result.unchanged += 1;
    } else {
      result.sanitized.push(file.path);
    }
  }
  if (result.sanitized.length !== manifest.transformations) {
    result.problems.push(`manifest records ${manifest.transformations} transformations, found ${result.sanitized.length}`);
  }
  return result;
}

/** Refresh sha256 and size for manifest entries whose bytes changed, then recompute transformations. */
export async function writeExportProvenance(root) {
  const manifestPath = join(root, "PUBLIC_EXPORT_MANIFEST.json");
  const original = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  const updated = [];
  for (const file of manifest.files) {
    let buffer;
    try { buffer = await readFile(join(root, file.path)); } catch { continue; }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (buffer.length !== file.size || sha256 !== file.sha256) {
      file.size = buffer.length;
      file.sha256 = sha256;
      updated.push(file.path);
    }
  }
  let sanitized = 0;
  for (const file of manifest.files) {
    let buffer;
    try { buffer = await readFile(join(root, file.path)); } catch { continue; }
    if (blobId(buffer, file.sourceObjectId) !== file.sourceObjectId) sanitized += 1;
  }
  manifest.transformations = sanitized;
  const next = `${JSON.stringify(manifest, null, 2)}${original.endsWith("\n") ? "\n" : ""}`;
  if (next !== original) await writeFile(manifestPath, next);
  return { updated, transformations: sanitized, files: manifest.files.length };
}

function parseCli(argv) {
  const write = argv.includes("--write");
  const positional = argv.filter((argument) => argument !== "--write");
  if (positional.length > 1 || argv.some((argument) => argument.startsWith("-") && argument !== "--write")) {
    throw new Error("Usage: verify-export-provenance.mjs [--write] [root]");
  }
  return { write, root: resolve(positional[0] ?? ".") };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { write, root } = parseCli(process.argv.slice(2));
    if (write) {
      const written = await writeExportProvenance(root);
      process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    }
    const result = await verifyExportProvenance(root);
    process.stdout.write(`${JSON.stringify({ ...result, ok: result.problems.length === 0 }, null, 2)}\n`);
    if (result.problems.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Export provenance check failed."}\n`);
    process.exitCode = 1;
  }
}
