/**
 * Where the paid product's source lives, for the checks that read it.
 *
 * The open-core checkout does not have that source, so every check that needs
 * it skips there, by name. Where it lives and which of its files each check
 * reads is written in `tools/scripts/private-tree.json`, a file only the full
 * checkout has. Without that file `present` is false and every path is null,
 * which is the open-core answer; the scripts stay identical in both checkouts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function privateTree(root) {
  const file = join(root, 'tools/scripts/private-tree.json')
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const dir = config?.dir ?? null
  const inside = (rel) => (dir && rel ? `${dir}/${rel}` : null)
  return {
    /** The tree is in this checkout. */
    present: dir !== null && existsSync(join(root, dir)),
    /** The tree's root with a trailing slash, or null. */
    prefix: dir && `${dir}/`,
    /** The source directory, or null. */
    src: inside(config?.src),
    /** One named file, or null. */
    file: (key) => inside(config?.files?.[key]),
    /** A named list of paths inside the tree, empty when the tree is not here. */
    list: (key) => (config?.[key] ?? []).map(inside),
    /** A named list as written, for names relative to a directory of the tree. */
    values: (key) => config?.[key] ?? [],
  }
}
