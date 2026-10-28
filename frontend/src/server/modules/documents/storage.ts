import path from "node:path";

import { settings } from "../../config";
import { HttpError } from "../../core/http";

export function storageRoot(): string {
  return path.resolve(settings.STORAGE_DIR);
}

/** Absolute path of a stored file; keys that escape the storage root are treated as missing. */
export function filePath(storageKey: string): string {
  const root = storageRoot();
  const p = path.resolve(root, storageKey);
  if (!p.startsWith(root + path.sep)) throw new HttpError(404, "File not found");
  return p;
}
