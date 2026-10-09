/**
 * Host functions a rule imports by name. AssemblyScript names an import after
 * the file that declares it, so a declaration in this file is `env.<name>`,
 * the module every proxy registers its imports under.
 */

/** See `readReferencedFile` in `referencedFiles.ts`, which is how a rule calls it. */
export declare function read_referenced_file(pathPtr: usize, pathLen: usize, outPtr: usize, outCap: usize): i32;
