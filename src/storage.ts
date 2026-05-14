/**
 * storage.ts — Initialize and manage the .opencode/learning/ directory.
 *
 * On plugin init:
 * 1. Ensure `.opencode/` exists with a `.gitignore` (exclude all by default)
 * 2. Ensure `.opencode/learning/` exists
 * 3. Create or load `meta.json` with project metadata
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ProjectIdentity } from "./project-id.js";

/** Parent directory for all opencode project-local output. */
const OPENCODE_DIR = ".opencode";

/** The storage subdirectory within .opencode/, created inside the repo root. */
export const STORAGE_DIR = ".opencode/learning";

/** Contents of the .gitignore inside .opencode/ — covers all subdirectories. */
const GITIGNORE_CONTENT = `*
!.gitignore
`;

// ---------------------------------------------------------------------------
// meta.json schema
// ---------------------------------------------------------------------------

export interface ProjectMeta {
  version: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  gitRemote: string | null;
  createdAt: string;
  lastExtractionAt: string | null;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the storage directory exists with required scaffolding.
 *
 * @param directory - The repo root / working directory
 * @param project - Detected project identity
 * @returns The loaded or newly created project metadata
 */
export function initStorage(
  directory: string,
  project: ProjectIdentity,
): ProjectMeta {
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

  // Load or create meta.json
  const metaPath = path.join(storageDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    return loadMeta(metaPath, directory, project);
  }
  return createMeta(metaPath, directory, project);
}

/**
 * Load existing meta.json, updating fields that may have changed
 * (e.g., projectRoot if the repo moved).
 */
function loadMeta(
  metaPath: string,
  directory: string,
  project: ProjectIdentity,
): ProjectMeta {
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    // Minimal shape check — route structurally invalid JSON to recreate path
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return createMeta(metaPath, directory, project);
    }

    const existing = parsed as Partial<ProjectMeta>;

    // Merge with current values — preserves createdAt and lastExtractionAt,
    // but updates projectRoot and gitRemote in case they changed
    const meta: ProjectMeta = {
      version: existing.version ?? "0.1.0",
      projectId: project.projectId,
      projectName: project.projectName,
      projectRoot: directory,
      gitRemote: project.gitRemote,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      lastExtractionAt: existing.lastExtractionAt ?? null,
    };

    // Write back if anything changed
    const updated = JSON.stringify(meta, null, 2) + "\n";
    if (updated !== raw) {
      fs.writeFileSync(metaPath, updated, "utf-8");
    }

    return meta;
  } catch {
    // Corrupted meta.json — recreate
    return createMeta(metaPath, directory, project);
  }
}

/** Create a fresh meta.json and write it to disk. */
function createMeta(
  metaPath: string,
  directory: string,
  project: ProjectIdentity,
): ProjectMeta {
  const meta: ProjectMeta = {
    version: "0.1.0",
    projectId: project.projectId,
    projectName: project.projectName,
    projectRoot: directory,
    gitRemote: project.gitRemote,
    createdAt: new Date().toISOString(),
    lastExtractionAt: null,
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  return meta;
}

/**
 * Get the absolute path to a file inside the storage directory.
 *
 * @param directory - The repo root / working directory
 * @param filename - File name within .opencode/learning/
 * @returns Absolute path to the file
 */
export function storagePath(directory: string, filename: string): string {
  return path.join(directory, STORAGE_DIR, filename);
}
