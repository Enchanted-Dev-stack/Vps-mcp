import type { Attachment, Chat, ChatDetail, Mode, Question, RepositoryBrowserResult, RunEvent, Workspace } from "./types";
let csrfToken = "";
export function setCsrf(value:string|null|undefined){ csrfToken = value ?? ""; }
async function request<T>(path:string, init:RequestInit={}):Promise<T>{
  const method=(init.method??"GET").toUpperCase();
  const headers=new Headers(init.headers);
  if(init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type","application/json");
  if(!["GET","HEAD","OPTIONS"].includes(method) && csrfToken) headers.set("x-csrf-token",csrfToken);
  const res=await fetch(path,{...init,headers,credentials:"include"});
  const text=await res.text();
  const body=text?JSON.parse(text):null;
  if(!res.ok) throw new Error(body?.error??`HTTP ${res.status}`);
  return body as T;
}
export const api={
  me:()=>request<{user:{id:string;username:string};csrfToken:string|null}>("/api/me"),
  login:(username:string,password:string)=>request<{user:{id:string;username:string};csrfToken:string}>("/api/auth/login",{method:"POST",body:JSON.stringify({username,password})}),
  logout:()=>request<{ok:boolean}>("/api/auth/logout",{method:"POST"}),
  workspaces:()=>request<Workspace[]>("/api/workspaces"),
  browseRepositories:(path?:string)=>request<RepositoryBrowserResult>(`/api/repositories/browse${path?`?path=${encodeURIComponent(path)}`:""}`),
  createWorkspace:(data:{name:string;rootPath:string;defaultBranch?:string;instructions?:string})=>request<Workspace>("/api/workspaces",{method:"POST",body:JSON.stringify(data)}),
  chats:(workspaceId:string)=>request<Chat[]>(`/api/workspaces/${workspaceId}/chats`),
  createChat:(workspaceId:string,data:{title:string;mode:Mode})=>request<Chat>(`/api/workspaces/${workspaceId}/chats`,{method:"POST",body:JSON.stringify(data)}),
  chat:(chatId:string)=>request<ChatDetail>(`/api/chats/${chatId}`),
  diff:(chatId:string)=>request<{short:string;diffStat:string;diff:string;worktreePath:string|null;branch?:string|null}>(`/api/chats/${chatId}/diff`),
  mode:(chatId:string,mode:Mode)=>request<Chat>(`/api/chats/${chatId}`,{method:"PATCH",body:JSON.stringify({mode})}),
  message:(chatId:string,content:string,attachmentIds:string[]=[])=>request(`/api/chats/${chatId}/messages`,{method:"POST",body:JSON.stringify({content,attachmentIds})}),
  upload:async(chatId:string,file:File)=>{const form=new FormData();form.append("file",file);return request<Attachment>(`/api/chats/${chatId}/attachments`,{method:"POST",body:form})},
  binding:(chatId:string)=>request<{token:string;expiresAt:string}>(`/api/chats/${chatId}/bindings`,{method:"POST"}),
  events:(chatId:string,after=0)=>request<RunEvent[]>(`/api/chats/${chatId}/events?after=${after}`),
  questions:(chatId:string)=>request<Question[]>(`/api/chats/${chatId}/questions`),
  answer:(questionId:string,answer:unknown)=>request<Question>(`/api/questions/${questionId}/answer`,{method:"POST",body:JSON.stringify({answer})}),
};
