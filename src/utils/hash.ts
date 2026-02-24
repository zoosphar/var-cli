import { createHash } from "crypto";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashFile(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

