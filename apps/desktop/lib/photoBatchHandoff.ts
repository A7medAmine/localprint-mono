// In-memory handoff between the dashboard's NewJobDialog and the Photo Batch
// tool. The dialog hands selected image files to PhotoBatchTool without writing
// file contents to sessionStorage — a module-level ref is enough because both
// screens live in the same SPA session.
let pendingFiles: File[] | null = null;

export function setPhotoBatchHandoff(files: File[]): void {
  pendingFiles = files;
}

export function consumePhotoBatchHandoff(): File[] | null {
  const f = pendingFiles;
  pendingFiles = null;
  return f;
}
