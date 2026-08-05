import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowLeft, Bot, Check, ChevronDown, CircleHelp, Code2, Copy, Eye, Folder, FolderGit2, Hammer,
  Link2, ListTodo, Loader2, LogOut, MoreHorizontal, Paperclip, Plus, Send, TerminalSquare, X
} from "lucide-react";
import { api, setCsrf } from "./api";
import type { Attachment, Chat, ChatDetail, Mode, Question, RepositoryBrowserResult, RunEvent, Workspace } from "./types";

const eventTypes=["agent.connected","agent.disconnected","activity","command.started","command.stdout","command.stderr","command.completed","files.changed","question.created","question.answered","run.completed","run.failed"];

function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><div className="modal"><div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose}><X size={17}/></button></div>{children}</div></div>
}

function Login({onLogin}:{onLogin:(username:string)=>void}){
  const [username,setUsername]=useState("admin"),[password,setPassword]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError("");try{const r=await api.login(username,password);setCsrf(r.csrfToken);onLogin(r.user.username)}catch(err){setError(err instanceof Error?err.message:"Login failed")}finally{setBusy(false)}}
  return <div className="login-shell"><form className="login-card" onSubmit={submit}><div className="brand-mark"><TerminalSquare size={22}/></div><h1>VPS Agent</h1><p>Sign in to your coding workspace.</p><label>Username<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username"/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" autoFocus/></label>{error&&<div className="error-box">{error}</div>}<button className="primary full" disabled={busy}>{busy?<Loader2 className="spin" size={16}/>:null}Sign in</button></form></div>
}

function ModeSwitch({mode,onChange}:{mode:Mode;onChange:(m:Mode)=>void}){
  const modes:[Mode,React.ReactNode,string][]=[["plan",<ListTodo size={14}/>,"Plan"],["build",<Hammer size={14}/>,"Build"],["review",<Eye size={14}/>,"Review"]];
  return <div className="mode-switch">{modes.map(([value,icon,label])=><button type="button" key={value} className={mode===value?"active":""} onClick={()=>onChange(value)}>{icon}{label}</button>)}</div>
}

function QuestionCard({question,onAnswer}:{question:Question;onAnswer:(q:Question,a:unknown)=>Promise<void>}){
  const [text,setText]=useState(""),[chosen,setChosen]=useState<string[]>([]),[busy,setBusy]=useState(false);
  const answer=async(value:unknown)=>{setBusy(true);try{await onAnswer(question,value)}finally{setBusy(false)}};
  return <div className="question-card"><div className="question-title"><CircleHelp size={16}/><span>{question.prompt}</span></div>
    {question.kind==="text"&&<div className="question-input"><input value={text} onChange={e=>setText(e.target.value)} placeholder="Type your answer…"/><button disabled={!text.trim()||busy} onClick={()=>answer(text.trim())}>Answer</button></div>}
    {question.kind==="confirm"&&<div className="choice-row"><button disabled={busy} onClick={()=>answer(true)}>Yes</button><button disabled={busy} onClick={()=>answer(false)}>No</button></div>}
    {question.kind==="single_choice"&&<div className="choices">{question.options.map(o=><button key={o} disabled={busy} onClick={()=>answer([o])}>{o}</button>)}</div>}
    {question.kind==="multi_choice"&&<><div className="choices multi">{question.options.map(o=><button key={o} className={chosen.includes(o)?"selected":""} onClick={()=>setChosen(v=>v.includes(o)?v.filter(x=>x!==o):[...v,o])}>{chosen.includes(o)&&<Check size={14}/>} {o}</button>)}</div><button className="question-submit" disabled={!chosen.length||busy} onClick={()=>answer(chosen)}>Submit</button></>}
  </div>
}

function ActivityFeed({events}:{events:RunEvent[]}){
  const [open,setOpen]=useState(true);
  const visible=events.slice(-40);
  const latest=visible.at(-1);
  return <div className="activity-wrap"><button className="activity-toggle" onClick={()=>setOpen(!open)}><span><Activity size={14}/>{latest?describeEvent(latest):"No agent activity yet"}</span><ChevronDown size={15} className={open?"rot":""}/></button>{open&&visible.length>0&&<div className="activity-list">{visible.map(e=><EventRow key={e.id} event={e}/>)}</div>}</div>
}
function describeEvent(e:RunEvent){const p=e.payload as Record<string,unknown>;switch(e.type){case"agent.connected":return"Agent connected";case"agent.disconnected":return"Agent disconnected";case"activity":return String(p.message??p.stage??"Working");case"command.started":return`Running ${String(p.command??"command")}`;case"command.completed":return`Command finished · exit ${String(p.exitCode??"?")}`;case"files.changed":return"Files changed";case"question.created":return"Waiting for your answer";case"run.completed":return"Run completed";case"run.failed":return"Run failed";default:return e.type}}
function EventRow({event:e}:{event:RunEvent}){const p=e.payload as Record<string,unknown>;if(e.type==="command.stdout"||e.type==="command.stderr")return <div className={`event-row output ${e.type.endsWith("stderr")?"stderr":""}`}><code>{String(p.chunk??"")}</code></div>;return <div className="event-row"><div className="event-dot"/><div><div className="event-main">{describeEvent(e)}</div>{e.type==="command.started"&&<code className="command-line">{String(p.command??"")}</code>}{e.type==="files.changed"&&Boolean(p.short)&&<code className="command-line">{String(p.short)}</code>}{e.type==="run.completed"&&Boolean(p.summary)&&<div className="event-summary">{String(p.summary)}</div>}<time>{new Date(e.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time></div></div>}

export function App(){
  const [booting,setBooting]=useState(true),[username,setUsername]=useState<string|null>(null);
  const [workspaces,setWorkspaces]=useState<Workspace[]>([]),[workspaceId,setWorkspaceId]=useState("");
  const [chats,setChats]=useState<Chat[]>([]),[chatId,setChatId]=useState("");
  const [detail,setDetail]=useState<ChatDetail|null>(null),[events,setEvents]=useState<RunEvent[]>([]);
  const [composer,setComposer]=useState(""),[sending,setSending]=useState(false),[uploading,setUploading]=useState(false),[pendingAttachments,setPendingAttachments]=useState<Attachment[]>([]),[error,setError]=useState("");
  const [showWorkspace,setShowWorkspace]=useState(false),[showChat,setShowChat]=useState(false),[showDiff,setShowDiff]=useState(false),[showSummary,setShowSummary]=useState(false),[binding,setBinding]=useState<{token:string;expiresAt:string}|null>(null);
  const bottomRef=useRef<HTMLDivElement>(null);
  const fileRef=useRef<HTMLInputElement>(null);

  const loadWorkspaces=useCallback(async()=>{const list=await api.workspaces();setWorkspaces(list);setWorkspaceId(id=>id&&list.some(w=>w.id===id)?id:(list[0]?.id??""));},[]);
  const refreshDetail=useCallback(async(id=chatId)=>{if(!id)return;const d=await api.chat(id);setDetail(d);},[chatId]);
  useEffect(()=>{api.me().then(r=>{setCsrf(r.csrfToken);setUsername(r.user.username);return loadWorkspaces()}).catch(()=>setUsername(null)).finally(()=>setBooting(false))},[loadWorkspaces]);
  useEffect(()=>{if(!username||!workspaceId){setChats([]);return}api.chats(workspaceId).then(list=>{setChats(list);setChatId(id=>id&&list.some(c=>c.id===id)?id:(list[0]?.id??""))}).catch(e=>setError(String(e)))},[username,workspaceId]);
  useEffect(()=>{setPendingAttachments([]);if(!chatId){setDetail(null);setEvents([]);return}let closed=false;Promise.all([api.chat(chatId),api.events(chatId)]).then(([d,e])=>{if(!closed){setDetail(d);setEvents(e)}}).catch(err=>!closed&&setError(String(err)));return()=>{closed=true}},[chatId]);
  useEffect(()=>{if(!chatId)return;const after=events.at(-1)?.seq??0;const source=new EventSource(`/api/chats/${chatId}/events/stream?after=${after}`,{withCredentials:true});const receive=(raw:MessageEvent)=>{try{const e=JSON.parse(raw.data) as RunEvent;setEvents(prev=>prev.some(x=>x.seq===e.seq)?prev:[...prev,e]);if(["run.completed","question.created","question.answered"].includes(e.type))void refreshDetail(chatId)}catch{}};for(const t of eventTypes)source.addEventListener(t,receive as EventListener);return()=>source.close()},[chatId,events.at(-1)?.seq,refreshDetail]);
  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth",block:"end"})},[detail?.messages.length,detail?.questions.length]);

  const selectedWorkspace=workspaces.find(w=>w.id===workspaceId);
  const connected=useMemo(()=>{for(let i=events.length-1;i>=0;i--){if(events[i].type==="agent.connected")return true;if(events[i].type==="agent.disconnected")return false}return false},[events]);
  async function send(){let content=composer.trim();if(!chatId||sending||(!content&&!pendingAttachments.length))return;if(!content)content=`Attached: ${pendingAttachments.map(a=>a.originalName).join(", ")}`;const attachments=[...pendingAttachments];setSending(true);setComposer("");setPendingAttachments([]);try{await api.message(chatId,content,attachments.map(a=>a.id));await refreshDetail()}catch(e){setComposer(content);setPendingAttachments(attachments);setError(e instanceof Error?e.message:String(e))}finally{setSending(false)}}
  async function uploadFiles(files:FileList|null){if(!files||!chatId)return;setUploading(true);try{for(const file of Array.from(files)){const uploaded=await api.upload(chatId,file);setPendingAttachments(v=>[...v,uploaded])}}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setUploading(false);if(fileRef.current)fileRef.current.value=""}}
  async function changeMode(mode:Mode){if(!detail)return;const updated=await api.mode(detail.id,mode);setDetail({...detail,...updated});setChats(v=>v.map(c=>c.id===updated.id?updated:c))}
  async function answer(q:Question,a:unknown){await api.answer(q.id,a);await refreshDetail()}
  async function logout(){try{await api.logout()}finally{setUsername(null);setWorkspaces([]);setCsrf(null)}}

  if(booting)return <div className="center-loader"><Loader2 className="spin"/></div>;
  if(!username)return <Login onLogin={u=>{setUsername(u);void loadWorkspaces()}}/>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark small"><TerminalSquare size={16}/></div><span>VPS Agent</span><button className="icon-btn side-more"><MoreHorizontal size={17}/></button></div>
      <div className="workspace-select"><button onClick={()=>setShowWorkspace(true)}><FolderGit2 size={15}/><span>{selectedWorkspace?.name??"New workspace"}</span><ChevronDown size={14}/></button></div>
      <div className="sidebar-section"><div className="sidebar-label"><span>Chats</span>{workspaceId&&<button className="icon-btn" onClick={()=>setShowChat(true)}><Plus size={15}/></button>}</div><div className="chat-list">{chats.map(c=><button key={c.id} className={chatId===c.id?"selected":""} onClick={()=>setChatId(c.id)}><Code2 size={14}/><span>{c.title}</span>{c.mode==="build"&&<span className="mode-dot build"/>}</button>)}{workspaceId&&!chats.length&&<div className="muted empty-side">No chats yet</div>}</div></div>
      <div className="sidebar-bottom"><div className="user-pill"><div className="avatar">{username.slice(0,1).toUpperCase()}</div><span>{username}</span><button className="icon-btn" onClick={logout} title="Sign out"><LogOut size={15}/></button></div></div>
    </aside>
    <main className="main">{detail?<><header className="chat-header"><div><div className="crumb">{selectedWorkspace?.name}<span>/</span></div><h2>{detail.title}</h2></div><div className="header-actions">{detail.worktreePath&&<button className="header-utility" onClick={()=>setShowDiff(true)}><Code2 size={14}/><span>Changes</span></button>}{detail.threadState?.summary&&<button className="header-utility" onClick={()=>setShowSummary(true)}><Activity size={14}/><span>Summary</span></button>}<ModeSwitch mode={detail.mode} onChange={changeMode}/><button className={`connect-btn ${connected?"connected":""}`} title={connected?"Connected MCP session. Portal messages are queued until that ChatGPT conversation runs/syncs.":"Create a one-time binding code for a ChatGPT conversation."} onClick={async()=>setBinding(await api.binding(detail.id))}><span className="status-dot"/>{connected?"Connected":"Connect"}<Link2 size={14}/></button></div></header>
      <section className="conversation"><div className="conversation-inner">{detail.messages.length===0&&<div className="empty-chat"><Bot size={24}/><h3>What should we work on?</h3><p>Send a task here, then connect a ChatGPT conversation with the binding code.</p></div>}{detail.messages.map(m=><div key={m.id} className={`message ${m.role}`}><div className="message-meta">{m.role==="user"?"You":m.role==="assistant"?"Agent":m.role}</div><div className="message-body">{m.content}</div><MessageAttachments attachments={detail.attachments.filter(a=>a.messageId===m.id)}/></div>)}{detail.questions.map(q=><QuestionCard key={q.id} question={q} onAnswer={answer}/>)}<div ref={bottomRef}/></div></section>
      <footer className="composer-area"><div className="composer-shell"><ActivityFeed events={events}/><div className="pending-files">{pendingAttachments.map(a=><span key={a.id}><Paperclip size={12}/>{a.originalName}<button onClick={()=>setPendingAttachments(v=>v.filter(x=>x.id!==a.id))}><X size={11}/></button></span>)}</div><div className="composer-row"><input ref={fileRef} type="file" multiple hidden onChange={e=>void uploadFiles(e.target.files)}/><button className="attach-btn" disabled={uploading} onClick={()=>fileRef.current?.click()} title="Attach files">{uploading?<Loader2 className="spin" size={16}/>:<Paperclip size={16}/>}</button><textarea value={composer} onChange={e=>setComposer(e.target.value)} placeholder={detail.mode==="plan"?"Ask the agent to inspect, plan, or clarify…":"Describe what you want to build…"} rows={1} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send()}}}/><button className="send-btn" disabled={(!composer.trim()&&!pendingAttachments.length)||sending||uploading} onClick={send}>{sending?<Loader2 className="spin" size={17}/>:<Send size={17}/>}</button></div><div className="composer-foot"><span>{detail.mode==="plan"?"Plan mode · inspection only":detail.mode==="build"?`Build mode · ${detail.branch??"isolated worktree on connect"}`:"Review mode · read-only review"}</span><span>Enter to send · Shift+Enter newline</span></div></div></footer></>:<div className="no-selection"><div className="brand-mark"><TerminalSquare size={22}/></div><h2>{workspaces.length?"Create or select a chat":"Create your first workspace"}</h2><p>Workspaces map to Git repositories on this VPS.</p><button className="primary" onClick={()=>workspaces.length?setShowChat(true):setShowWorkspace(true)}><Plus size={16}/>{workspaces.length?"New chat":"New workspace"}</button></div>}</main>
    {error&&<div className="toast"><span>{error}</span><button onClick={()=>setError("")}><X size={15}/></button></div>}
    {showWorkspace&&<WorkspaceModal workspaces={workspaces} current={workspaceId} onSelect={id=>{setWorkspaceId(id);setShowWorkspace(false)}} onCreated={async w=>{await loadWorkspaces();setWorkspaceId(w.id);setShowWorkspace(false)}} onClose={()=>setShowWorkspace(false)}/>} 
    {showChat&&workspaceId&&<NewChatModal onClose={()=>setShowChat(false)} onCreate={async data=>{const c=await api.createChat(workspaceId,data);setChats(await api.chats(workspaceId));setChatId(c.id);setShowChat(false)}}/>}
    {binding&&<BindingModal binding={binding} onClose={()=>setBinding(null)}/>} 
    {showDiff&&detail&&<DiffModal chatId={detail.id} onClose={()=>setShowDiff(false)}/>}
    {showSummary&&detail?.threadState&&<SummaryModal state={detail.threadState} onClose={()=>setShowSummary(false)}/>}
  </div>
}

function MessageAttachments({attachments}:{attachments:Attachment[]}){if(!attachments.length)return null;return <div className="message-attachments">{attachments.map(a=>a.mimeType.startsWith("image/")?<a className="image-attachment" key={a.id} href={`/api/attachments/${a.id}`} target="_blank"><img src={`/api/attachments/${a.id}`} alt={a.originalName}/><span>{a.originalName}</span></a>:<a className="file-attachment" key={a.id} href={`/api/attachments/${a.id}`} target="_blank"><Paperclip size={14}/><span>{a.originalName}</span><small>{Math.max(1,Math.round(a.sizeBytes/1024))} KB</small></a>)}</div>}

function DiffModal({chatId,onClose}:{chatId:string;onClose:()=>void}){const[data,setData]=useState<{short:string;diffStat:string;diff:string;branch?:string|null}|null>(null),[error,setError]=useState("");useEffect(()=>{api.diff(chatId).then(setData).catch(e=>setError(e instanceof Error?e.message:String(e)))},[chatId]);return <Modal title="Changes" onClose={onClose}><div className="diff-body">{error?<div className="error-box">{error}</div>:!data?<div className="modal-loading"><Loader2 className="spin" size={17}/>Loading changes…</div>:<>{data.branch&&<div className="diff-branch"><Code2 size={14}/>{data.branch}</div>}{data.short?<><pre className="diff-status">{data.short}</pre>{data.diffStat&&<pre className="diff-stat">{data.diffStat}</pre>}<pre className="diff-code">{data.diff||"Tracked diff is empty; changes may be untracked files listed above."}</pre></>:<div className="empty-diff">No uncommitted changes in this worktree.</div>}</>}</div></Modal>}
function SummaryModal({state,onClose}:{state:{summary:string;structured:Record<string,unknown>};onClose:()=>void}){return <Modal title="Run summary" onClose={onClose}><div className="summary-body"><p>{state.summary}</p>{Object.keys(state.structured??{}).length>0&&<><div className="summary-label">Structured state</div><pre>{JSON.stringify(state.structured,null,2)}</pre></>}</div></Modal>}

function RepositoryPicker({onSelect,onClose}:{onSelect:(path:string)=>void;onClose:()=>void}){
  const [data,setData]=useState<RepositoryBrowserResult|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const load=useCallback(async(path?:string)=>{setLoading(true);setError("");try{setData(await api.browseRepositories(path))}catch(err){setError(err instanceof Error?err.message:String(err))}finally{setLoading(false)}},[]);
  useEffect(()=>{void load()},[load]);
  return <Modal title="Select repository" onClose={onClose}><div className="repo-picker">
    <div className="repo-picker-head">{data?.currentPath&&<button type="button" className="icon-btn repo-back" onClick={()=>void load(data.parentPath??undefined)} title="Back"><ArrowLeft size={15}/></button>}<div><b>{data?.currentPath??"VPS locations"}</b><small>Choose an existing Git repository on this VPS.</small></div></div>
    {error&&<div className="error-box">{error}</div>}
    {loading?<div className="modal-loading"><Loader2 className="spin" size={16}/>Loading folders…</div>:<>
      {!data?.currentPath?<div className="repo-list">{data?.roots.map(root=><button type="button" key={root.path} onClick={()=>void load(root.path)}><Folder size={16}/><span><b>{root.name}</b><small>{root.path}</small></span><ChevronDown className="repo-chevron" size={14}/></button>)}</div>:<>
        {data.isGitRepository&&<div className="repo-current"><FolderGit2 size={16}/><span><b>Git repository detected</b><small>{data.currentPath}</small></span><button type="button" className="primary" onClick={()=>onSelect(data.currentPath!)}>Use repository</button></div>}
        <div className="repo-list">{data.entries.map(entry=><div className={`repo-row ${entry.isGitRepository?"is-repo":""}`} key={entry.path}><button type="button" className="repo-open" onClick={()=>void load(entry.path)}><span className="repo-icon">{entry.isGitRepository?<FolderGit2 size={16}/>:<Folder size={16}/>}</span><span><b>{entry.name}</b><small>{entry.isGitRepository?"Git repository":entry.path}</small></span></button>{entry.isGitRepository&&<button type="button" className="repo-use" onClick={()=>onSelect(entry.path)}>Select</button>}</div>)}{!data.entries.length&&<div className="repo-empty">No subfolders here.</div>}</div>
      </>}
    </>}
    <div className="repo-picker-note">This browser only shows server folders under approved VPS roots. A normal browser file picker would browse your own PC, not the VPS.</div>
  </div></Modal>
}

function WorkspaceModal({workspaces,current,onSelect,onCreated,onClose}:{workspaces:Workspace[];current:string;onSelect:(id:string)=>void;onCreated:(w:Workspace)=>void;onClose:()=>void}){
  const [creating,setCreating]=useState(workspaces.length===0);
  const [name,setName]=useState("");
  const [rootPath,setRootPath]=useState("");
  const [instructions,setInstructions]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [browse,setBrowse]=useState(false);

  async function create(e:React.FormEvent){
    e.preventDefault();
    setBusy(true); setError("");
    try { onCreated(await api.createWorkspace({name,rootPath,instructions})); }
    catch(err){ setError(err instanceof Error?err.message:String(err)); setBusy(false); }
  }

  return <>
    <Modal title="Workspaces" onClose={onClose}>
      {!creating ? <>
        <div className="workspace-list">{workspaces.map(w=><button key={w.id} className={w.id===current?"active":""} onClick={()=>onSelect(w.id)}><FolderGit2 size={16}/><span><b>{w.name}</b><small>{w.rootPath}</small></span>{w.id===current&&<Check size={16}/>}</button>)}</div>
        <button className="secondary full" onClick={()=>setCreating(true)}><Plus size={15}/>New workspace</button>
      </> : <form className="form-stack" onSubmit={create}>
        <label>Name<input value={name} onChange={e=>setName(e.target.value)} placeholder="Spotlyst" autoFocus required/></label>
        <div className="field-group repository-field">
          <span>Project repository</span>
          <div className="repository-input"><input aria-label="Project repository" value={rootPath} onChange={e=>setRootPath(e.target.value)} placeholder="Select an existing Git repository on the VPS" required/><button type="button" className="secondary" onClick={()=>setBrowse(true)}><Folder size={14}/>Browse VPS</button></div>
          <small>This is the source Git repository the agent will work on. Workspace/chat data is stored separately by the portal.</small>
        </div>
        <label>Project instructions<textarea rows={5} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="Testing commands, architecture rules, things the agent must preserve…"/></label>
        {error&&<div className="error-box">{error}</div>}
        <div className="modal-actions">{workspaces.length>0&&<button type="button" className="secondary" onClick={()=>setCreating(false)}>Back</button>}<button className="primary" disabled={busy||!name.trim()||!rootPath.trim()}>{busy&&<Loader2 className="spin" size={15}/>}Create workspace</button></div>
      </form>}
    </Modal>
    {browse&&<RepositoryPicker onClose={()=>setBrowse(false)} onSelect={path=>{setRootPath(path);setBrowse(false)}}/>}
  </>
}

function NewChatModal({onClose,onCreate}:{onClose:()=>void;onCreate:(data:{title:string;mode:Mode})=>void}){const[title,setTitle]=useState(""),[mode,setMode]=useState<Mode>("plan");return <Modal title="New chat" onClose={onClose}><form className="form-stack" onSubmit={e=>{e.preventDefault();onCreate({title,mode})}}><label>Task name<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Fix onboarding flow" autoFocus required/></label><div className="field-group"><span>Starting mode</span><ModeSwitch mode={mode} onChange={setMode}/></div><p className="hint">Plan and Review restrict workspace commands to inspection. Build gets its own Git worktree.</p><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!title.trim()}>Create chat</button></div></form></Modal>}
function BindingModal({binding,onClose}:{binding:{token:string;expiresAt:string};onClose:()=>void}){const[copied,setCopied]=useState(false);const instruction=`connect to ${binding.token}`;return <Modal title="Connect ChatGPT" onClose={onClose}><div className="binding-body"><p>Open a ChatGPT conversation that has this MCP enabled and send:</p><div className="binding-code"><code>{instruction}</code><button onClick={async()=>{await navigator.clipboard.writeText(instruction);setCopied(true);setTimeout(()=>setCopied(false),1200)}}>{copied?<Check size={16}/>:<Copy size={16}/>}</button></div><div className="binding-notes"><div><span>One-time code</span><small>It can bind only one MCP session.</small></div><div><span>Expires</span><small>{new Date(binding.expiresAt).toLocaleTimeString()}</small></div></div><p className="hint">Each portal chat should be connected to a different ChatGPT conversation to avoid conflicts. MCP cannot wake an idle ChatGPT Web tab by itself, so portal messages remain queued until that connected conversation runs/syncs.</p></div></Modal>}
