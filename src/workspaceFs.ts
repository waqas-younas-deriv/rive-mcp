// Policy for all paths supplied through MCP tools or the Studio.
// This is defense in depth, not an OS sandbox against hostile local processes.
import * as fs from "node:fs";
import { isAbsolute, relative, resolve, sep, parse } from "node:path";
import { homedir } from "node:os";

const configuredRoot = process.env.RIVE_MCP_WORKSPACE;
let root: string | undefined;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function workspaceRoot(): string {
  if (root) return root;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error("Set RIVE_MCP_WORKSPACE to an absolute path to a dedicated animation folder.");
  }
  const candidate = fs.realpathSync(configuredRoot);
  if (!fs.statSync(candidate).isDirectory() || candidate === parse(candidate).root || candidate === fs.realpathSync(homedir())) {
    throw new Error("RIVE_MCP_WORKSPACE must be a dedicated folder, not a home directory or filesystem root.");
  }
  root = candidate;
  return root;
}

export function workspacePath(input: unknown): string {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("A filesystem path string is required.");
  const base = workspaceRoot();
  let full = resolve(base, input);
  // A user-selected root may itself use an OS alias (e.g. /var on macOS).
  const configuredRelative = relative(resolve(configuredRoot!), full);
  if (configuredRelative !== ".." && !configuredRelative.startsWith(`..${sep}`) && !isAbsolute(configuredRelative)) {
    full = resolve(base, configuredRelative);
  }
  const rel = relative(base, full);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path is outside RIVE_MCP_WORKSPACE.");
  const parts = rel ? rel.split(sep) : [];
  // Hidden configuration, dependency trees and OS-specific alternate stream names
  // are never legitimate animation inputs/outputs.
  if (parts.some(p => p.startsWith(".") || p.toLowerCase() === "node_modules" || /[:\\]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("Hidden/configuration paths and dependency directories are not accessible.");
  }
  let cursor = base;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink > 1)) {
        throw new Error("Symlinks, hard-linked files and special files are not accessible.");
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return full;
}

function guarded<T extends (...args: any[]) => any>(fn: T, read = false): T {
  return ((path: unknown, ...args: unknown[]) => {
    const full = workspacePath(path);
    if (read && fs.statSync(full).size > MAX_FILE_BYTES) throw new Error("Input file exceeds the 64 MiB limit.");
    return Reflect.apply(fn, fs, [full, ...args]);
  }) as T;
}

export const readFileSync = guarded(fs.readFileSync, true);
export const writeFileSync: typeof fs.writeFileSync = ((path: unknown, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
  const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (size > MAX_FILE_BYTES) throw new Error("Output file exceeds the 64 MiB limit.");
  return Reflect.apply(fs.writeFileSync, fs, [workspacePath(path), data, ...args]);
}) as typeof fs.writeFileSync;
export const existsSync = guarded(fs.existsSync);
export const statSync = guarded(fs.statSync);
export const readdirSync = guarded(fs.readdirSync);
export const mkdirSync = guarded(fs.mkdirSync);
export const watch = guarded(fs.watch);
export { type Dirent, type FSWatcher } from "node:fs";
