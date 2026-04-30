/**
 * project-id.ts — Derive a stable 12-char hex project ID from git remote or repo path.
 *
 * Detection priority:
 * 1. `git remote get-url origin` -> hash to 12-char hex (portable across machines)
 * 2. `git rev-parse --show-toplevel` -> hash to 12-char hex (machine-specific)
 * 3. Fallback: "global"
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";

/** Hash a string to a 12-character hex digest. */
function hashTo12Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export interface ProjectIdentity {
  projectId: string;
  projectName: string;
  gitRemote: string | null;
}

/**
 * Detect the project identity from git metadata.
 *
 * @param directory - The working directory (repo root)
 * @returns Project identity with a 12-char hex ID, display name, and optional git remote
 */
export function detectProject(directory: string): ProjectIdentity {
  // Try git remote first — portable across machines
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: directory,
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (remote !== "") {
      // Extract project name from remote URL
      // Handles: git@github.com:user/repo.git, git@github.com:repo.git,
      //          https://github.com/user/repo.git
      const nameMatch = /[/:]([^/:]+?)(?:\.git)?$/.exec(remote);
      const projectName = nameMatch?.[1] ?? extractDirName(directory);

      return {
        projectId: hashTo12Hex(remote),
        projectName,
        gitRemote: remote,
      };
    }
  } catch {
    // No remote configured or git not available
  }

  // Fallback: repo root path — machine-specific but stable
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: directory,
      encoding: "utf-8",
      timeout: 3_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (repoRoot !== "") {
      return {
        projectId: hashTo12Hex(repoRoot),
        projectName: extractDirName(repoRoot),
        gitRemote: null,
      };
    }
  } catch {
    // Not a git repo
  }

  // Final fallback
  return {
    projectId: "global",
    projectName: extractDirName(directory),
    gitRemote: null,
  };
}

/** Extract the last path component as the directory name. */
function extractDirName(dirPath: string): string {
  return path.basename(dirPath) || "unknown";
}
