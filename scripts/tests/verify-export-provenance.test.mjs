import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyExportProvenance, writeExportProvenance } from "../verify-export-provenance.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const blob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

test("separates unchanged and sanitized files and reports any file that differs from the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-provenance-"));
  await writeFile(join(root, "same.txt"), "same\n");
  await writeFile(join(root, "clean.txt"), "public value\n");
  await writeFile(join(root, "edited.txt"), "edited after export\n");
  const files = [
    { path: "same.txt", sourceObjectId: blob("same\n"), sha256: sha256("same\n"), size: 5 },
    { path: "clean.txt", sourceObjectId: blob("private value\n"), sha256: sha256("public value\n"), size: 13 },
    { path: "edited.txt", sourceObjectId: blob("x\n"), sha256: sha256("original\n"), size: 9 }
  ];
  await writeFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), JSON.stringify({ sourceCommit: "a".repeat(40), transformations: 1, files }));
  const result = await verifyExportProvenance(root);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.sanitized, ["clean.txt"]);
  assert.deepEqual(result.problems, ["differs from the manifest: edited.txt"]);
});

test("write mode records the new bytes and counts the edited file as sanitized", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-provenance-write-"));
  await writeFile(join(root, "edited.txt"), "edited after export\n");
  const files = [
    { path: "edited.txt", sourceObjectId: blob("original\n"), sha256: sha256("original\n"), size: 9 }
  ];
  await writeFile(join(root, "PUBLIC_EXPORT_MANIFEST.json"), JSON.stringify({ sourceCommit: "a".repeat(40), transformations: 0, files }));
  const written = await writeExportProvenance(root);
  assert.deepEqual(written.updated, ["edited.txt"]);
  assert.equal(written.transformations, 1);
  const result = await verifyExportProvenance(root);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.sanitized, ["edited.txt"]);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});

test("write mode leaves the manifest unchanged when a listed file cannot be read", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-provenance-missing-"));
  const manifestPath = join(root, "PUBLIC_EXPORT_MANIFEST.json");
  const files = [
    { path: "missing.txt", sourceObjectId: blob("x\n"), sha256: sha256("x\n"), size: 2 }
  ];
  const original = JSON.stringify({ sourceCommit: "a".repeat(40), transformations: 0, files });
  await writeFile(manifestPath, original);
  await assert.rejects(() => writeExportProvenance(root), /Cannot read exported file missing\.txt/);
  assert.equal(await readFile(manifestPath, "utf8"), original);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
});
