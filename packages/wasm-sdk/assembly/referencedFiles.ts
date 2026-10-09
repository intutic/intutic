/**
 * Reading a manifest the request names, through `env.read_referenced_file`:
 * the host copies the bytes of a file this request's tool calls name (under
 * INTUTIC_WASM_MANIFEST_ROOT) into guest memory.
 *
 * A module of its own, imported by the rules that read files, so the template
 * and every rule that does not import it carry no file-reading import: the
 * proxy reads files for a request only when a loaded rule imports the function.
 *
 * The codes are the proxies' (`referenced_files.rs`, `referencedFiles.ts`).
 */

import { read_referenced_file } from "./env";

/** Malformed call: pointers outside memory, a bad length, a non-UTF-8 path. */
export const ERR_BAD_ARGS: i32 = -1;
/** The call never named this path, or it failed a path guard; or no root is set. */
export const ERR_REFUSED: i32 = -2;
/** Named and allowed, but not on disk. */
export const ERR_NOT_FOUND: i32 = -3;
/** Over 256 KiB. No bytes are exposed. */
export const ERR_TOO_LARGE: i32 = -4;
/** The buffer was smaller than the file. `readReferencedFile` sizes it first. */
export const ERR_BUFFER_TOO_SMALL: i32 = -5;
/** This evaluation used its 64 reads. */
export const ERR_BUDGET: i32 = -6;
/**
 * Not read: the request names more manifests than the host reads (8), or a
 * command longer than it scans (64 KiB), and this path is not among those
 * read. Padding a command with decoys produces exactly this, so a rule that
 * governs the path must refuse on it rather than treat it as nothing to check.
 */
export const ERR_NOT_READ: i32 = -7;


/** One referenced file: its bytes, or why there are none. */
export class ReferencedFile {
  /** 0 when read; otherwise one of the ERR_ codes above. */
  code: i32 = 0;
  bytes: Uint8Array = new Uint8Array(0);

  /**
   * Whether a rule governing this path must refuse: the call named it and the
   * rule could not see it. Only ERR_NOT_FOUND (named, and genuinely absent) is
   * left to the rule's own judgement.
   */
  get unread(): bool {
    return this.code != 0 && this.code != ERR_NOT_FOUND;
  }
}

/**
 * Read a file the request's tool calls name, by the path exactly as the call
 * spelled it: a size query, then the copy.
 */
export function readReferencedFile(path: string): ReferencedFile {
  const out = new ReferencedFile();
  const name = String.UTF8.encode(path);
  const size = read_referenced_file(changetype<usize>(name), <usize>name.byteLength, 0, 0);
  if (size < 0) {
    out.code = size;
    return out;
  }
  const buf = new Uint8Array(size);
  const copied = read_referenced_file(changetype<usize>(name), <usize>name.byteLength, buf.dataStart, <usize>size);
  if (copied < 0) {
    out.code = copied;
    return out;
  }
  out.bytes = buf;
  return out;
}
