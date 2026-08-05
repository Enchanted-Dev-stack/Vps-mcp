import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileTypeFromBuffer } from "file-type";

export function normalizeFilename(value: string): string {
  const clean = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.slice(0, 240) || "upload.bin";
}

export interface StoredAttachment {
  originalName: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
}

export class AttachmentStore {
  constructor(readonly root: string, readonly maxBytes = 25 * 1024 * 1024) {}

  async put(buffer: Buffer, originalName: string, declaredMime = "application/octet-stream"): Promise<StoredAttachment> {
    if (buffer.length > this.maxBytes) throw new Error(`Attachment is too large (max ${this.maxBytes} bytes)`);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const dir = join(this.root, sha256.slice(0, 2));
    const storagePath = join(dir, sha256);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    try { await writeFile(storagePath, buffer, { flag: "wx", mode: 0o640 }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
    const mimeType = detected?.mime ?? (declaredMime || "application/octet-stream");
    return { originalName: normalizeFilename(originalName), mimeType, sha256, sizeBytes: buffer.length, storagePath };
  }

  async read(storagePath: string): Promise<Buffer> { return readFile(storagePath); }
}
