import { createRequire } from "node:module";
import type { CliHostSpawn } from "./types.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
let cachedNodePty: NodePtyModule | null = null;

// The core image imports CliHostClient from this package. Loading node-pty here
// would make that import fail unless core also shipped the native module.
function loadNodePty(): NodePtyModule {
  if (!cachedNodePty) {
    cachedNodePty = require("node-pty") as NodePtyModule;
  }
  return cachedNodePty;
}

/**
 * Disable the PTY interrupt characters (ISIG) for every CLI pane so that
 * Ctrl-C is delivered to the CLI as the byte 0x03 (its own interrupt/cancel
 * key) instead of SIGINT. Without this, an accidental Ctrl-C kills the whole
 * CLI tree and the pane exits. Admin-initiated termination (SIGTERM/SIGHUP)
 * and app-level exits (Ctrl-D, /exit) are unaffected.
 */
export const spawnNodePty: CliHostSpawn = (spec) =>
  loadNodePty().spawn("/bin/sh", ["-c", '/usr/bin/stty -isig; exec "$@"', "space-cli-host", spec.command, ...spec.args], {
    name: "xterm-256color",
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env
  });
