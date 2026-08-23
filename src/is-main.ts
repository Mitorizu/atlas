import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * True when this module is the process entry point.
 *
 * `import.meta.filename === process.argv[1]` is the obvious form and is wrong: under some
 * loaders both sides are undefined, so an imported module compares equal to the entry
 * point and runs its main() on import.
 */
export function isMain(metaFilename: string | undefined): boolean {
  const entry = process.argv[1];
  if (metaFilename === undefined || entry === undefined) return false;
  try {
    return realpathSync(metaFilename) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}
