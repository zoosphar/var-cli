import { basename } from "path";
import { createHash } from "crypto";

// Generate a deterministic slug for a codebase (same project = same slug)
export function generateCodebaseSlug(projectPath: string, projectName?: string): string {
  const name = projectName || basename(projectPath);
  
  // Sanitize the name: lowercase, replace spaces/special chars with dashes
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
  
  // Create a short hash from the absolute path for uniqueness
  const pathHash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 8);
  
  return `${sanitizedName}-${pathHash}`;
}

// Generate a unique slug with timestamp (for when you want separate scans)
export function generateUniqueCodebaseSlug(projectPath: string, projectName?: string): string {
  const name = projectName || basename(projectPath);
  const timestamp = Date.now();
  
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  
  return `${sanitizedName}-${timestamp}`;
}

