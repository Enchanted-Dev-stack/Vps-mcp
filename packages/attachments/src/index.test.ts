import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore, normalizeFilename } from "./index.js";

describe("attachments",()=>{
  it("normalizes hostile filenames",()=>{
    expect(normalizeFilename("../../evil\u0000.png")).toBe("evil.png");
    expect(normalizeFilename("  report final.pdf  ")).toBe("report final.pdf");
  });
  it("stores content by hash and deduplicates",async()=>{
    const root=await mkdtemp(join(tmpdir(),"vpsmcp-att-"));
    const store=new AttachmentStore(root,1024);
    const a=await store.put(Buffer.from("hello"),"note.txt","text/plain");
    const b=await store.put(Buffer.from("hello"),"other.txt","text/plain");
    expect(a.sha256).toBe(b.sha256); expect(a.storagePath).toBe(b.storagePath); expect(a.mimeType).toBe("text/plain");
    expect((await readFile(a.storagePath)).toString()).toBe("hello");
    await expect(store.put(Buffer.alloc(2048),"big.bin","application/octet-stream")).rejects.toThrow(/too large/i);
  });
});
