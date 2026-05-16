/**
 * storage.ts — Initialize and manage the .opencode/learning/ directory.
 *
 * On plugin init:
 * 1. Ensure `.opencode/` exists with a `.gitignore` (exclude all by default)
 * 2. Ensure `.opencode/learning/` exists
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Parent directory for all opencode project-local output. */
const OPENCODE_DIR = ".opencode";

/** The storage subdirectory within .opencode/, created inside the repo root. */
export const STORAGE_DIR = ".opencode/learning";

/** Contents of the .gitignore inside .opencode/ — covers all subdirectories. */
const GITIGNORE_CONTENT = `*
!.gitignore
`;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the storage directory exists with required scaffolding.
 *
 * Creates `.opencode/` and `.opencode/learning/` directories, and ensures
 * a `.gitignore` exists inside `.opencode/` that excludes all contents.
 *
 * @param directory - The repo root / working directory
 */
export function initStorage(directory: string): void {
  const opencodeDir = path.join(directory, OPENCODE_DIR);
  const storageDir = path.join(directory, STORAGE_DIR);

  // Create .opencode/ parent if needed
  if (!fs.existsSync(opencodeDir)) {
    fs.mkdirSync(opencodeDir, { recursive: true });
  }

  // Ensure .opencode/.gitignore exists (covers all subdirectories)
  const gitignorePath = path.join(opencodeDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf-8");
  }

  // Create learning/ subdirectory if needed
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
}

/**
 * Get the absolute path to a file inside the storage directory.
 *
 * @param directory - The repo root / working directory
 * @param filename - File name within .opencode/learning/
 * @returns Absolute path to the file
 */
export function storagePath(directory: string, filename: string): string {
  return path.join(directory, STORAGE_DIR, path.basename(filename));
}
