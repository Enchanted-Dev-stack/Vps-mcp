export type Mode = "plan" | "build" | "review";
export interface Workspace { id:string; name:string; rootPath:string; defaultBranch:string; instructions:string; }
export interface Chat { id:string; workspaceId:string; title:string; mode:Mode; status:string; branch:string|null; worktreePath:string|null; createdAt:string; updatedAt:string; }
export interface Message { id:string; chatId:string; seq:number; role:"system"|"user"|"assistant"|"tool"; source:string; content:string; createdAt:string; }
export interface Question { id:string; chatId:string; runId:string|null; kind:"text"|"single_choice"|"multi_choice"|"confirm"; prompt:string; options:string[]; allowMultiple:boolean; status:string; answer:unknown; createdAt:string; }
export interface RunEvent { id:string; chatId:string; runId:string|null; seq:number; type:string; payload:Record<string,unknown>; createdAt:string; }
export interface Attachment { id:string; chatId:string; messageId:string|null; originalName:string; mimeType:string; sha256:string; sizeBytes:number; createdAt:string; }
export interface ChatDetail extends Chat { messages:Message[]; questions:Question[]; attachments:Attachment[]; threadState:{summary:string; structured:Record<string,unknown>}|null; }
