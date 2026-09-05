const socket=io();
// A persistent per-tab id, independent of socket.id. socket.id changes every time
// the underlying connection drops and reconnects (backgrounding the tab on mobile,
// a brief wifi hiccup, etc.) -- which used to silently strand that player outside
// their own room with no error and no way to move or place a wall. This id survives
// reconnects, so the server can seat the new socket right back into the same slot.
let clientId=localStorage.getItem("cq_client_id");
if(!clientId){clientId=(crypto.randomUUID?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2));localStorage.setItem("cq_client_id",clientId);}
// Which room we're seated in. Kept in localStorage (not just a JS variable)
// so a saved seat survives a full page reload or the tab being closed and
// reopened -- but a fresh page load should NOT silently drop the person back
// into a match without asking; that's jarring if they closed the tab on
// purpose. So `myRoomCode` itself only gets set once we're actually back in
// a room (by us confirming a resume, or by a normal create/join), and
// `sessionActive` is what makes the "connect" handler below auto-rejoin --
// it's only true for socket.io's own silent reconnects during a session
// that's already running (wifi blip, tab backgrounded), never for the very
// first connect after a fresh page load.
let myRoomCode=null;
let sessionActive=false;
socket.on("connect",()=>{ if(myRoomCode&&sessionActive) socket.emit("rejoin",{code:myRoomCode,clientId}); });
let state=null,myIndex=-1,prevState=null;
let muted=(localStorage.getItem("cq_muted")==="1");
let knownWallKeys=new Set();
let audioCtx=null;
let account=JSON.parse(localStorage.getItem("cq_account")||"null"); // {token,username,wins,games,createdAt}

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
function toast(m){const t=$("#toast");t.textContent=m;t.style.display="block";clearTimeout(window.__t);window.__t=setTimeout(()=>t.style.display="none",2200)}
function boardN(){ return (state&&state.n)?state.n:11; }

/* ---------- board rotation: always show *your* pawn at the bottom ---------- */
// Slots go clockwise N=0,E=1,S=2,W=3 around the board. To bring "my" slot to
// the South position we rotate the whole visual grid by k*90° clockwise,
// where k=(2-mySlot+4)%4. This only ever affects how things are drawn —
// every socket event and legality check still uses the real, un-rotated
// board coordinates the server works with.
function myK(){
  if(!state||myIndex<0)return 0;
  const me=state.players[myIndex];
  if(!me)return 0;
  return (2-me.slot+4)%4;
}
function invK(k){ return (4-(((k%4)+4)%4))%4; }
function cellRotate(r,c,k,n){
  k=((k%4)+4)%4;
  if(k===0)return[r,c];
  if(k===1)return[c,n-1-r];
  if(k===2)return[n-1-r,n-1-c];
  return[n-1-c,r]; // k===3
}
// Every wall (r,c) anchors the same corner point regardless of orientation:
// the intersection of the 4 cells around (r+1,c+1). Rotate that corner point
// the same way, then flip h/v when the rotation is an odd multiple of 90°.
function wallRotate(r,c,o,k,n){
  k=((k%4)+4)%4;
  if(k===0)return{r,c,o};
  const pr=r+1,pc=c+1;
  let npr,npc;
  if(k===1){npr=pc;npc=n-pr;}
  else if(k===2){npr=n-pr;npc=n-pc;}
  else {npr=n-pc;npc=pr;}
  return{r:npr-1,c:npc-1,o:(k%2===1)?(o==="h"?"v":"h"):o};
}
function fmtClock(ms){
  const s=Math.max(0,Math.ceil(ms/1000));
  const m=Math.floor(s/60),ss=s%60;
  return `${m}:${String(ss).padStart(2,"0")}`;
}
function fmtDate(ts){
  if(!ts)return"";
  try{return new Date(ts).toLocaleDateString("ar-EG",{year:"numeric",month:"long"});}catch(e){return"";}
}

/* ---------- sound ---------- */
function ensureAudio(){
  if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==="suspended") audioCtx.resume();
  return audioCtx;
}
function beep(freq,dur,type,gain,delay){
  if(muted) return;
  try{
    const ctx=ensureAudio();
    const t0=ctx.currentTime+(delay||0);
    const osc=ctx.createOscillator();osc.type=type||"sine";osc.frequency.value=freq;
    const g=ctx.createGain();g.gain.value=0;
    osc.connect(g);g.connect(ctx.destination);
    g.gain.linearRampToValueAtTime(gain||.05,t0+.01);
    g.gain.exponentialRampToValueAtTime(.0001,t0+dur);
    osc.start(t0);osc.stop(t0+dur+.03);
  }catch(e){}
}
const sndMove=()=>beep(520,.08,"triangle",.05);
const sndWall=()=>beep(170,.13,"square",.04);
const sndTurn=()=>beep(760,.06,"sine",.03);
const sndError=()=>beep(140,.15,"sawtooth",.045);
const sndWin=()=>{beep(660,.12,"sine",.06);beep(880,.12,"sine",.06,.12);beep(1100,.2,"sine",.07,.24);};
const sndTap=()=>beep(900,.05,"sine",.03);

function updateMuteBtn(){$("#muteBtn").textContent=muted?"🔇":"🔊";$("#muteBtn").title=muted?"تشغيل الصوت":"كتم الصوت";}
$("#muteBtn").onclick=()=>{
  muted=!muted;localStorage.setItem("cq_muted",muted?"1":"0");updateMuteBtn();
  if(!muted) ensureAudio();
};
updateMuteBtn();

/* ---------- accounts ---------- */
function saveAccount(a){account=a;localStorage.setItem("cq_account",JSON.stringify(a));renderAccount();}
function clearAccount(){account=null;localStorage.removeItem("cq_account");renderAccount();}
function renderAccount(){
  const label=$("#acctLabel"),avatar=$("#acctAvatar");
  if(account){
    label.textContent=account.username;
    avatar.textContent=account.username.trim()[0]?.toUpperCase()||"👤";
    $("#acctMenuName").textContent=account.username;
    const wins=account.wins??0,games=account.games??0;
    $("#acctWins").textContent=wins;
    $("#acctGames").textContent=games;
    $("#acctWinrate").textContent=games>0?Math.round(wins/games*100)+"%":"—";
    $("#acctSince").textContent=account.createdAt?("عضو من "+fmtDate(account.createdAt)):"";
    $("#acctDashLink").hidden=!(account.role==="owner"||account.role==="mod");
    if(!$("#name").value) $("#name").value=account.username;
  } else {
    label.textContent="تسجيل الدخول";
    avatar.textContent="👤";
  }
}
renderAccount();
if(account){
  fetch(`/api/me?token=${encodeURIComponent(account.token)}`).then(r=>r.json()).then(d=>{
    if(!d.error) saveAccount({...account,wins:d.wins,games:d.games,username:d.username,createdAt:d.createdAt,role:d.role});
    else clearAccount();
  }).catch(()=>{});
}

$("#acctBtn").onclick=()=>{
  if(account){
    const m=$("#acctMenu");
    m.hidden=!m.hidden;
  } else {
    openAuth();
  }
};
document.addEventListener("click",e=>{
  if(!$("#acctChip").contains(e.target)) $("#acctMenu").hidden=true;
});
$("#logoutBtn").onclick=()=>{
  if(account) fetch("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token})}).catch(()=>{});
  clearAccount();$("#acctMenu").hidden=true;toast("تم تسجيل الخروج.");
};

let authMode="login";
function openAuth(mode){
  authMode=mode==="register"?"register":"login";syncAuthTabs();
  $("#authError").hidden=true;$("#authResend").hidden=true;
  $("#authUser").value="";$("#authEmail").value="";$("#authPass").value="";
  $("#authModal").hidden=false;
  (authMode==="login"?$("#authEmail"):$("#authUser")).focus();
}
function closeAuth(){$("#authModal").hidden=true;}
function syncAuthTabs(){
  $("#tabLogin").classList.toggle("active",authMode==="login");
  $("#tabRegister").classList.toggle("active",authMode==="register");
  $("#authSubmit").textContent=authMode==="login"?"تسجيل الدخول":"إنشاء الحساب";
  // Login is by email + password only; the username field is register-only.
  $("#authUser").hidden=authMode==="login";
  $("#authResend").hidden=true;
}
$("#tabLogin").onclick=()=>{authMode="login";syncAuthTabs();$("#authError").hidden=true;};
$("#tabRegister").onclick=()=>{authMode="register";syncAuthTabs();$("#authError").hidden=true;};
$("#authClose").onclick=closeAuth;
$("#authModal").addEventListener("click",e=>{if(e.target.id==="authModal") closeAuth();});
$("#authSubmit").onclick=async()=>{
  const username=$("#authUser").value.trim(),email=$("#authEmail").value.trim(),password=$("#authPass").value;
  if(!email||!password||(authMode==="register"&&!username)){showAuthError(authMode==="register"?"اكتب اسم المستخدم والبريد الإلكتروني وكلمة السر.":"اكتب البريد الإلكتروني وكلمة السر.");return;}
  $("#authResend").hidden=true;
  try{
    const body=authMode==="login"?{email,password}:{username,email,password};
    const res=await fetch(`/api/${authMode==="login"?"login":"register"}`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    const d=await res.json();
    if(!res.ok||d.error){
      showAuthError(d.error||"حصل خطأ، حاول تاني.");
      if(d.needsVerification) $("#authResend").hidden=false;
      return;
    }
    if(d.requireVerification){
      authMode="login";syncAuthTabs();
      toast(d.message||"ابعتنالك رابط تفعيل على بريدك الإلكتروني.");
      return;
    }
    saveAccount(d);
    closeAuth();
    toast(authMode==="login"?`أهلاً ${d.username}!`:`اتعمل الحساب، أهلاً ${d.username}!`);
  }catch(e){showAuthError("مشكلة في الاتصال بالسيرفر.");}
};
$("#authResend").onclick=async()=>{
  const email=$("#authEmail").value.trim();
  if(!email){showAuthError("اكتب البريد الإلكتروني الأول.");return;}
  try{
    const res=await fetch("/api/resend-verification",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});
    const d=await res.json();
    toast(d.message||"لو الإيميل ده متسجل، هيوصلك رابط تفعيل جديد.");
    $("#authResend").hidden=true;
  }catch(e){toast("مشكلة في الاتصال بالسيرفر.");}
};
function showAuthError(m){const el=$("#authError");el.textContent=m;el.hidden=false;}
$("#authPass").addEventListener("keydown",e=>{if(e.key==="Enter")$("#authSubmit").click();});
$("#authUser").addEventListener("keydown",e=>{if(e.key==="Enter")$("#authEmail").focus();});
$("#authEmail").addEventListener("keydown",e=>{if(e.key==="Enter")$("#authPass").focus();});

/* ---------- email verification landing (?verified=1 / ?verify_error=1) ---------- */
(function handleVerifyRedirect(){
  const p=new URLSearchParams(location.search);
  if(p.get("verified")==="1"){
    history.replaceState(null,"",location.pathname+location.search.replace(/[?&]verified=1/,"").replace(/^&/,"?"));
    toast("تم تفعيل بريدك الإلكتروني! سجل دخولك دلوقتي.");
    openAuth("login");
  }else if(p.get("verify_error")==="1"){
    history.replaceState(null,"",location.pathname);
    toast("رابط التفعيل مش صحيح أو خلصت صلاحيته. جرب تسجل الدخول عشان تطلب رابط جديد.");
  }
})();

/* ---------- leaderboard ---------- */
$("#lbBtn").onclick=async()=>{
  $("#lbModal").hidden=false;
  $("#lbList").innerHTML=`<div class="hist-empty">بيحمل...</div>`;
  try{
    const res=await fetch("/api/leaderboard");
    const list=await res.json();
    if(!list.length){$("#lbList").innerHTML=`<div class="hist-empty">لسه مفيش نتايج مسجلة.</div>`;return;}
    $("#lbList").innerHTML=list.map((u,i)=>`
      <div class="lb-row">
        <span class="lb-rank">#${i+1}</span>
        <span class="lb-name">${esc(u.username)}</span>
        <span class="lb-wins">${u.wins} فوز</span>
        <span class="lb-games">${u.games} مباراة</span>
      </div>`).join("");
  }catch(e){$("#lbList").innerHTML=`<div class="hist-empty">مشكلة في تحميل القائمة.</div>`;}
};
$("#lbClose").onclick=()=>{$("#lbModal").hidden=true;};
$("#lbModal").addEventListener("click",e=>{if(e.target.id==="lbModal")$("#lbModal").hidden=true;});

/* ---------- game mode selector (lobby) ---------- */
let selectedMode="center";
const modeHints={center:"كل اللاعبين بيتسابقوا لنفس المربع الأصفر في النص.",classic:"1 ضد 1 كلاسيك: كل لاعب بيبدأ من ناحية، وأول واحد يوصل للطرف التاني بتاعه يكسب."};
function setMode(m){
  selectedMode=m;
  $("#modeCenter").classList.toggle("active",m==="center");
  $("#modeClassic").classList.toggle("active",m==="classic");
  $("#modeHint").textContent=modeHints[m];
}
$("#modeCenter").onclick=()=>setMode("center");
$("#modeClassic").onclick=()=>setMode("classic");

/* ---------- invite link (join a room by URL, not just by typing the code) ---------- */
// Whoever sent the link just wants the other person to land straight in the
// room -- not fill a field and hunt for a button. If we already know their
// name (logged in, or they've played here before) we join immediately. The
// only time we still need a tap is the very first visit from someone with no
// saved name at all, and even then a single Enter press is enough.
let pendingInviteCode=null;
function doJoin(name,code){
  ensureAudio();
  const finalName=(name||"Player").trim();
  if(finalName) localStorage.setItem("cq_name",finalName);
  socket.emit("joinRoom",{name:finalName,code,token:account?.token,clientId});
}
(function handleInviteLink(){
  const p=new URLSearchParams(location.search);
  const code=(p.get("room")||"").trim().toUpperCase();
  if(!code)return;
  history.replaceState(null,"",location.pathname);
  // An invite link means "join a specific room by name", not "resume my own
  // seat" -- clear any saved room so the resume banner below doesn't compete
  // with it.
  localStorage.removeItem("cq_room_code");
  hideResumeBanner();
  $("#code").value=code;
  const savedName=account?.username||localStorage.getItem("cq_name")||"";
  if(savedName){
    $("#name").value=savedName;
    doJoin(savedName,code);
  }else{
    pendingInviteCode=code;
    toast("اكتب اسمك ودوس Enter عشان تدخل غرفة صاحبك على طول.");
    $("#name").focus();
  }
})();
$("#name").addEventListener("keydown",e=>{
  if(e.key!=="Enter")return;
  if(pendingInviteCode){ const c=pendingInviteCode;pendingInviteCode=null;doJoin($("#name").value,c); }
  else if(($("#code").value||"").trim()) $("#join").click();
  else $("#create").click();
});

/* ---------- resume banner: reconnecting after a page reload is a deliberate,
   visible choice, not something that happens to you the instant the page
   loads ---------- */
function hideResumeBanner(){ $("#resumeBanner").hidden=true; }
(function initResumeBanner(){
  const saved=localStorage.getItem("cq_room_code");
  if(saved) $("#resumeBanner").hidden=false;
})();
$("#resumeBtn").onclick=()=>{
  const saved=localStorage.getItem("cq_room_code");
  if(!saved){ hideResumeBanner(); return; }
  myRoomCode=saved;sessionActive=true;
  socket.emit("rejoin",{code:myRoomCode,clientId});
};
$("#dismissResumeBtn").onclick=()=>{
  localStorage.removeItem("cq_room_code");
  hideResumeBanner();
};
function inviteLink(code){ return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`; }
async function copyInviteLink(){
  if(!state?.code)return;
  const link=inviteLink(state.code);
  try{
    if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
    else { const ta=document.createElement("textarea");ta.value=link;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove(); }
    toast("تم نسخ رابط الدعوة!");
  }catch(e){ toast("معرفتش أنسخ الرابط، انسخه يدوي: "+link); }
}
$("#inviteBtn").onclick=copyInviteLink;

/* ---------- socket wiring ---------- */
$("#create").onclick=()=>{
  ensureAudio();
  const finalName=($("#name").value||"Player 1").trim();
  if(finalName) localStorage.setItem("cq_name",finalName);
  socket.emit("createRoom",{name:finalName,token:account?.token,mode:selectedMode,clientId});
};
$("#join").onclick=()=>doJoin($("#name").value||"Player",($("#code").value||"").trim());
$("#start").onclick=()=>socket.emit("startGame");
$("#restart").onclick=()=>{ if(!$("#restart").disabled) socket.emit("requestRematch"); };
$("#rematchAccept").onclick=()=>socket.emit("rematchResponse",{accept:true});
$("#rematchDecline").onclick=()=>socket.emit("rematchResponse",{accept:false});
socket.on("rematchDeclined",({name})=>toast(`${name} رفض يلعب مرة تانية.`));
$("#leaveGame").onclick=()=>socket.emit("leaveRoom");
$("#surrenderBtn").onclick=()=>{
  if(confirm("متأكد إنك عايز تستسلم؟ هتخسر المباراة على طول.")) socket.emit("leaveRoom");
};
socket.on("errorMsg",m=>{toast(m);sndError();});
function backToLobby(){
  state=null;myIndex=-1;myRoomCode=null;sessionActive=false;
  localStorage.removeItem("cq_room_code");
  hideResumeBanner();
  $("#lobby").hidden=false;$("#game").hidden=true;$("#win").hidden=true;
  $("#roomBadge").hidden=true;$("#inviteBtn").hidden=true;
}
socket.on("kicked",({reason})=>{
  backToLobby();
  toast(reason==="ban"?"اتعملك بان من الغرفة دي.":reason==="forfeit"?"مقدرش يرجعك للغرفة (يمكن المباراة خلصت أو الغرفة مش موجودة).":"المضيف طردك من الغرفة.");
});
// Fired back at us after we deliberately hit "خروج" (leaveRoom) -- unlike
// "kicked" this is our own choice, so no toast, just drop back to the lobby.
socket.on("leftRoom",()=>{ backToLobby(); });
socket.on("state",s=>{
  prevState=state;state=s;myIndex=s.players.findIndex(p=>p.id===socket.id);
  myRoomCode=s.code;
  sessionActive=true;
  localStorage.setItem("cq_room_code",s.code);
  hideResumeBanner();
  clearHoverPreview();
  reactToChange(prevState,s);
  render();
});

function reactToChange(prev,s){
  if(!prev){ if(s.walls.length===0) knownWallKeys=new Set(); return; }
  if(s.walls.length===0 && prev.walls.length>0) knownWallKeys=new Set(); // restart
  if(s.winner!==null && prev.winner===null){ sndWin(); return; }
  if(s.walls.length>prev.walls.length){ sndWall(); return; }
  const moved=s.positions.some((p,i)=>prev.positions[i] && (p.r!==prev.positions[i].r||p.c!==prev.positions[i].c));
  if(moved){ sndMove(); return; }
  if(s.started && (!prev.started || s.turn!==prev.turn) && s.winner===null && s.turn===myIndex) sndTurn();
}

/* ---------- lobby / sidebar / history ---------- */
function render(){
  if(!state)return;
  $("#roomBadge").hidden=false;
  $("#inviteBtn").hidden=false;
  $("#roomBadge").textContent="ROOM "+state.code+(state.mode==="classic"?" • 1v1":" • مركز");
  $("#players").innerHTML=Array.from({length:4},(_,i)=>{
    const p=state.players[i];
    return p
      ? `<div class="slot"><span style="color:${p.color}">●</span> ${esc(p.name)}${p.account?' <span class="acct-badge" title="حساب مسجل">✓</span>':""}${p.isHost?' <span class="host-badge" title="المضيف">👑</span>':""}</div>`
      : `<div class="slot empty">لاعب ${i+1} — في انتظار الدخول</div>`;
  }).join("");

  $("#start").hidden=!(myIndex===0&&state.players.length>=2&&!state.started);
  const cap=state.mode==="classic"?2:4;
  $("#lobbyMsg").textContent=state.started?"المباراة بدأت.":`اللاعبون ${state.players.length}/${cap} — تقدروا تبدأوا من لاعبين.`;
  $("#ruleGoal").textContent=state.mode==="classic"?"• 🟨 وصولك للطرف التاني اللي متجه له يفوز.":"• 🟨 الوصول للمربع الأصفر في النص يفوز.";
  $("#lobby").hidden=state.started;
  $("#game").hidden=!state.started;
  if(!state.started)return;

  $("#matchInfo").innerHTML=`<span>⏱️ ٥:٠٠ لكل لاعب</span><span class="dot-sep">•</span><span>${state.mode==="classic"?"1 ضد 1 كلاسيك":"مركز — حتى ٤ لاعبين"}</span>`;

  const totalMs=state.playerTimeMs||300000;
  $("#playerList").innerHTML=state.players.map((p,i)=>{
    const isActive=i===state.turn&&state.winner===null;
    const remain=isActive&&state.turnDeadline?Math.max(0,state.turnDeadline-Date.now()):(state.timeLeft?.[p.slot]??totalMs);
    const low=remain<30000;
    return `
    <div class="pitem ${isActive?"active":""}" data-slot="${p.slot}" style="border-inline-start:3px solid ${p.color}">
      <span class="dot" style="background:${p.color};color:${p.color}"></span>
      <span class="pname"><b>${esc(p.name)}${p.account?' <span class="acct-badge" title="حساب مسجل">✓</span>':""}${p.isHost?' <span class="host-badge" title="المضيف">👑</span>':""}${i===myIndex?" (أنت)":""}${p.connected===false?` <span class="host-badge grace" title="لازم يرجع خلال المهلة وإلا يخسر" data-grace="${p.slot}">🔄 <span class="grace-count"></span></span>`:""}</b><span class="pmeta">🧱 ${state.wallsLeft[i]} حاجز متبقي</span></span>
      <span class="pitem-right"><span class="clock ${low?"low":""}" data-clock="${p.slot}">${fmtClock(remain)}</span></span>
    </div>`;
  }).join("");

  $("#turnText").textContent=state.winner!==null?"انتهت المباراة":state.turn===myIndex?"دورك":`دور ${esc(state.players[state.turn].name)}`;
  // Only worth offering while the match is actually live -- once there's a
  // winner the win screen's own "خروج" button takes over.
  $("#surrenderBtn").hidden=state.winner!==null;
  renderHistory();
  updateWallTiles();
  drawBoard();

  if(state.winner!==null){
    $("#win").hidden=false;
    if(state.winReason==="forfeit"){
      const names=(state.winners&&state.winners.length?state.winners:[state.winner])
        .map(i=>state.players[i]?esc(state.players[i].name):null).filter(Boolean).join("، ");
      const many=state.winners&&state.winners.length>1;
      $("#winText").innerHTML=`<h2>${names} ${many?"كسبوا":"كسب"}!</h2><p>${esc(state.forfeitedName||"لاعب")} خرج من المباراة ومرجعش خلال ٣٠ ثانية.</p>`;
    } else if(state.winReason==="surrender"){
      const names=(state.winners&&state.winners.length?state.winners:[state.winner])
        .map(i=>state.players[i]?esc(state.players[i].name):null).filter(Boolean).join("، ");
      const many=state.winners&&state.winners.length>1;
      $("#winText").innerHTML=`<h2>${names} ${many?"كسبوا":"كسب"}!</h2><p>${esc(state.forfeitedName||"لاعب")} استسلم.</p>`;
    } else {
      $("#winText").innerHTML=`<h2>${esc(state.players[state.winner].name)} كسب!</h2><p>وصل للمربع الأصفر في المنتصف.</p>`;
    }
    // "Play again" needs everyone still at the table to actually agree, not
    // just the host hitting a button and forcing a fresh match on people who
    // never said yes. See requestRematch/rematchResponse.
    const restartBtn=$("#restart"),leaveBtn=$("#leaveGame"),note=$("#winActionsNote");
    const rematchPrompt=$("#rematchPrompt"),rematchPromptText=$("#rematchPromptText");
    const enoughPlayers=state.players.length>=2;
    const myId=socket.id;
    if(state.rematch){
      const iRequested=state.rematch.requestedBy===myId;
      const iAccepted=state.rematch.accepted.includes(myId);
      restartBtn.hidden=true;
      leaveBtn.hidden=false;
      if(iRequested||iAccepted){
        rematchPrompt.hidden=true;
        note.hidden=false;
        note.textContent="في انتظار موافقة باقي اللاعبين...";
      }else{
        const requester=state.players.find(p=>p.id===state.rematch.requestedBy);
        rematchPromptText.textContent=`${requester?requester.name:"لاعب"} عايز يلعب مرة تانية، موافق؟`;
        rematchPrompt.hidden=false;
        note.hidden=true;
      }
    }else{
      rematchPrompt.hidden=true;
      note.hidden=true;
      restartBtn.hidden=false;
      restartBtn.disabled=!enoughPlayers;
      restartBtn.title=enoughPlayers?"":"محتاجين ٢ لاعبين على الأقل عشان تلعبوا مرة تانية — دوس خروج.";
      leaveBtn.hidden=false;
    }
    clearHoverPreview();clearDragPreview();
  } else $("#win").hidden=true;
}

function renderHistory(){
  const el=$("#history");
  if(!state.history||!state.history.length){
    el.innerHTML=`<div class="hist-empty">لسه معملتوش حركات</div>`;return;
  }
  el.innerHTML=state.history.slice(-40).reverse().map(h=>{
    const label=h.type==="move"?"تحرك":`حط حاجز ${h.o==="h"?"أفقي":"رأسي"}`;
    return `<div class="hist-item"><span class="dot" style="background:${h.color}"></span><span>${esc(h.name)} ${label}${h.auto?' <em>(تلقائي)</em>':""}</span></div>`;
  }).join("");
}

/* ---------- per-player clocks ---------- */
function updateClocks(){
  if(!state||!state.started)return;
  // Reconnect countdowns keep ticking even after the match ends by forfeit,
  // so they run in their own pass; the turn clocks stop once there's a winner.
  document.querySelectorAll("[data-grace]").forEach(el=>{
    const slot=Number(el.dataset.grace);
    const pl=state.players.find(p=>p.slot===slot);
    const span=el.querySelector(".grace-count");
    if(!pl||!pl.graceUntil||!span)return;
    span.textContent=Math.max(0,Math.ceil((pl.graceUntil-Date.now())/1000))+"s";
  });
  if(state.winner!==null)return;
  const totalMs=state.playerTimeMs||300000;
  document.querySelectorAll("[data-clock]").forEach(el=>{
    const slot=Number(el.dataset.clock);
    const isActiveSlot=state.players[state.turn]&&state.players[state.turn].slot===slot;
    const remain=isActiveSlot&&state.turnDeadline?Math.max(0,state.turnDeadline-Date.now()):(state.timeLeft?.[slot]??totalMs);
    el.textContent=fmtClock(remain);
    el.classList.toggle("low",remain<30000);
  });
}
setInterval(updateClocks,250);

/* ---------- turn / wall bookkeeping ---------- */
function myTurnNow(){ return !!(state&&state.started&&state.winner===null&&state.turn===myIndex); }
function wallsLeftMine(){
  if(!state||!state.started||myIndex<0)return 0;
  // wallsLeft is tracked server-side per player-order index (same index turn
  // cycles through), NOT per physical board slot -- those two only coincide for
  // whichever player happens to be host. Using slot here returned someone else's
  // wall count for the other 3 players in a 4-player game.
  return state.wallsLeft[myIndex]??0;
}
function updateWallTiles(){
  const left=wallsLeftMine();
  $("#wallCountH").textContent=left;
  $("#wallCountV").textContent=left;
  const enabled=myTurnNow()&&left>0;
  $("#wallTileH").classList.toggle("disabled",!enabled);
  $("#wallTileV").classList.toggle("disabled",!enabled);
}
function attemptMove(r,c){
  if(!myTurnNow()){sndError();return;}
  socket.emit("move",{r,c});
}
function attemptPlaceWall(r,c,o){
  if(!myTurnNow()){toast("لسه مش دورك.");sndError();return;}
  if(wallsLeftMine()<=0){toast("خلصت الحواجز بتاعتك.");sndError();return;}
  socket.emit("placeWall",{r,c,o});
}

/* ---------- board geometry / legality (client-side mirror of server) ---------- */
function blockedWith(walls,r1,c1,r2,c2){
  if(r1===r2){
    const c=Math.min(c1,c2);
    return walls.some(w=>w.o==="v"&&w.c===c&&w.r<=r1&&r1<=w.r+1);
  }
  if(c1===c2){
    const r=Math.min(r1,r2);
    return walls.some(w=>w.o==="h"&&w.r===r&&w.c<=c1&&c1<=w.c+1);
  }
  return true;
}
function blocked(r1,c1,r2,c2){ return blockedWith(state.walls,r1,c1,r2,c2); }
// Mirrors the server's isWin(): center mode shares one goal cell; classic
// mode is always the top/bottom pairing (slots 0 and 2), each racing to the
// edge opposite where they started.
function isWinFor(slot,r,c){
  if(state&&state.mode==="classic") return r===(slot===0?boardN()-1:0);
  const cc=state?state.c:5;
  return r===cc&&c===cc;
}
function pawnAt(r,c,ignoreSlot){
  return state.players.find(pl=>pl.slot!==ignoreSlot&&state.positions[pl.slot].r===r&&state.positions[pl.slot].c===c)?.slot??-1;
}
function getClientLegalMoves(slot){
  if(slot==null)return [];
  const n=boardN();
  const p=state.positions[slot],out=[];
  for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){
    const nr=p.r+dr,nc=p.c+dc;
    if(nr<0||nr>=n||nc<0||nc>=n||blocked(p.r,p.c,nr,nc))continue;
    const occ=pawnAt(nr,nc,slot);
    if(occ===-1){out.push({r:nr,c:nc});continue;}
    const jr=nr+dr,jc=nc+dc;
    if(jr>=0&&jr<n&&jc>=0&&jc<n&&pawnAt(jr,jc,slot)===-1&&!blocked(nr,nc,jr,jc)){out.push({r:jr,c:jc});continue;}
    const sides=dr!==0?[[0,-1],[0,1]]:[[-1,0],[1,0]];
    for(const [sr,sc] of sides){
      const ar=nr+sr,ac=nc+sc;
      if(ar>=0&&ar<n&&ac>=0&&ac<n&&pawnAt(ar,ac,slot)===-1&&!blocked(nr,nc,ar,ac))out.push({r:ar,c:ac});
    }
  }
  return out;
}
function clientHasPath(walls,startR,startC,slot){
  const q=[[startR,startC]],seen=new Set([`${startR},${startC}`]);
  while(q.length){
    const [r,c]=q.shift();
    if(isWinFor(slot,r,c))return true;
    for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){
      const nr=r+dr,nc=c+dc;
      if(nr<0||nr>=boardN()||nc<0||nc>=boardN()||blockedWith(walls,r,c,nr,nc))continue;
      const k=`${nr},${nc}`;
      if(!seen.has(k)){seen.add(k);q.push([nr,nc]);}
    }
  }
  return false;
}
// Mirrors the server's validWall check so the wall preview can show green/red
// feedback before the click even reaches the server.
function clientValidWall(r,c,o){
  const wn=boardN()-1;
  if(!state||r<0||c<0||r>=wn||c>=wn)return false;
  if(state.walls.some(w=>w.r===r&&w.c===c&&w.o===o))return false;
  if(o==="h"){
    if(state.walls.some(w=>w.o==="h"&&w.r===r&&Math.abs(w.c-c)<=1))return false;
    if(state.walls.some(w=>w.o==="v"&&w.r===r&&w.c===c))return false;
  }else{
    if(state.walls.some(w=>w.o==="v"&&w.c===c&&Math.abs(w.r-r)<=1))return false;
    if(state.walls.some(w=>w.o==="h"&&w.r===r&&w.c===c))return false;
  }
  const testWalls=[...state.walls,{r,c,o}];
  for(const pl of state.players){
    const p=state.positions[pl.slot];
    if(!clientHasPath(testWalls,p.r,p.c,pl.slot))return false;
  }
  return true;
}
function wallRectStyle(r,c,o,cw,ch){
  if(o==="h")return{left:c*cw+4,top:(r+1)*ch-4,width:2*cw-8,height:9};
  return{left:(c+1)*cw-4,top:r*ch+4,width:9,height:2*ch-8};
}
// Finds the wall gap nearest the given board-relative point, but only within
// a fairly tight band around each boundary line — the rest of every cell
// stays 100% dedicated to move-clicks. This is the actual fix for the old
// bug: there is no invisible DOM hitbox stacked over the cells anymore, just
// coordinate math with a deliberately small capture zone.
function nearestWallSlot(x,y,cw,ch){
  const n=boardN(),wMax=n-2;
  const rowF=y/ch,colF=x/cw;
  const rb=Math.round(rowF),cb=Math.round(colF);
  const rDist=Math.abs(rowF-rb),cDist=Math.abs(colF-cb);
  const THRESH=0.13;
  const hOk=rb>=1&&rb<=n-1&&rDist<THRESH;
  const vOk=cb>=1&&cb<=n-1&&cDist<THRESH;
  if(hOk&&(!vOk||rDist<=cDist)) return{o:"h",r:rb-1,c:clamp(Math.round(colF)-1,0,wMax)};
  if(vOk) return{o:"v",r:clamp(Math.round(rowF)-1,0,wMax),c:cb-1};
  return null;
}

/* ---------- animation helpers ---------- */
function capturePawnRects(b){
  const rects={};
  b.querySelectorAll(".pawn[data-slot]").forEach(el=>{rects[el.dataset.slot]=el.getBoundingClientRect();});
  return rects;
}
function applyFlip(b,oldRects){
  b.querySelectorAll(".pawn[data-slot]").forEach(el=>{
    const old=oldRects[el.dataset.slot];
    if(!old)return;
    const nr=el.getBoundingClientRect();
    const dx=old.left-nr.left, dy=old.top-nr.top;
    if(Math.abs(dx)<.5&&Math.abs(dy)<.5)return;
    el.style.transition="none";
    el.style.transform=`translate(${dx}px,${dy}px)`;
    requestAnimationFrame(()=>{
      el.style.transition="transform .28s cubic-bezier(.22,.8,.32,1)";
      el.style.transform="translate(0,0)";
    });
  });
}

/* ---------- board rendering ---------- */
const boardEl=$("#board");
function boardMetrics(){
  const rect=boardEl.getBoundingClientRect();
  const n=boardN();
  return{rect,cw:rect.width/n,ch:rect.height/n};
}
function drawBoard(){
  const b=boardEl;
  const oldRects=capturePawnRects(b);
  b.innerHTML="";
  hoverPreviewEl=null;dragPreviewEl=null; // stale refs after innerHTML wipe; recreated lazily
  const n=boardN();
  const k=myK();
  b.style.gridTemplateColumns=`repeat(${n},1fr)`;
  b.style.gridTemplateRows=`repeat(${n},1fr)`;
  const active=state.players.findIndex(p=>p.id===socket.id);
  const currentSlot=active>=0?state.players[active].slot:null;
  const myTurn=myTurnNow();
  const legal=new Set();
  if(myTurn) getClientLegalMoves(currentSlot).forEach(x=>legal.add(`${x.r},${x.c}`));

  for(let r=0;r<n;r++){
    for(let c=0;c<n;c++){
      // Classic 1v1 has no single glowing goal square — both back rows are
      // an ordinary part of the board, exactly like real Quoridor.
      const isGoal=state.mode!=="classic"&&r===state.c&&c===state.c;
      const cell=document.createElement("div");
      cell.className="cell"+(isGoal?" goal":"");
      if(legal.has(`${r},${c}`))cell.classList.add("legal");
      const[dr,dc]=cellRotate(r,c,k,n);
      cell.style.gridRow=dr+1;cell.style.gridColumn=dc+1;

      const slot=state.positions.findIndex((p,slot)=>p.r===r&&p.c===c&&state.players.some(pl=>pl.slot===slot));
      if(slot>=0){
        const pl=state.players.find(pl=>pl.slot===slot);
        if(pl){
          const pawn=document.createElement("div");
          pawn.className="pawn"+(pl.id===socket.id?" me":"");
          pawn.dataset.slot=String(slot);
          pawn.style.background=pl.color;
          cell.appendChild(pawn);
        }
      }
      b.appendChild(cell);
    }
  }

  const rect=b.getBoundingClientRect(), cw=rect.width/n, ch=rect.height/n;
  for(const w of state.walls){
    const key=`${w.r},${w.c},${w.o}`;
    const isNew=!knownWallKeys.has(key);
    knownWallKeys.add(key);
    const disp=wallRotate(w.r,w.c,w.o,k,n);
    const wall=document.createElement("div");
    wall.className=`wall ${disp.o}`+(isNew?" wall-in":"");
    // Color the wall with the exact color of the player who placed it (their
    // own pawn color), instead of a fixed p0..p3 palette keyed to seat order.
    wall.style.background=w.color||"#8a93a0";
    const st=wallRectStyle(disp.r,disp.c,disp.o,cw,ch);
    wall.style.left=st.left+"px";wall.style.top=st.top+"px";wall.style.width=st.width+"px";wall.style.height=st.height+"px";
    b.appendChild(wall);
  }

  applyFlip(b,oldRects);
}
window.addEventListener("resize",()=>{if(state?.started)drawBoard();});

/* ---------- wall hover preview (mouse) ---------- */
const canHover=!!(window.matchMedia&&window.matchMedia("(pointer: fine)").matches);
let hoverPreviewEl=null,dragPreviewEl=null;
function makePreviewEl(){
  const el=document.createElement("div");
  el.className="wall-preview";
  boardEl.appendChild(el);
  return el;
}
function positionPreviewEl(el,r,c,o,cw,ch,valid){
  const disp=wallRotate(r,c,o,myK(),boardN());
  const st=wallRectStyle(disp.r,disp.c,disp.o,cw,ch);
  el.style.left=st.left+"px";el.style.top=st.top+"px";el.style.width=st.width+"px";el.style.height=st.height+"px";
  el.classList.toggle("invalid",!valid);
  el.style.display="block";
}
function clearHoverPreview(){
  if(hoverPreviewEl) hoverPreviewEl.style.display="none";
  boardEl.style.cursor="";
}
// The hover preview IS the confirmation step: you already see exactly where
// the wall would land (green = legal, red = illegal) before you ever click,
// so a single precise click is enough — no extra "click again to confirm"
// dance needed.
function showHoverPreview(slot,cw,ch){
  if(!slot||!myTurnNow()){clearHoverPreview();return;}
  if(!hoverPreviewEl||!hoverPreviewEl.isConnected) hoverPreviewEl=makePreviewEl();
  positionPreviewEl(hoverPreviewEl,slot.r,slot.c,slot.o,cw,ch,clientValidWall(slot.r,slot.c,slot.o));
  boardEl.style.cursor="pointer";
}
function clearDragPreview(){ if(dragPreviewEl) dragPreviewEl.style.display="none"; }
function showDragPreview(r,c,o,valid,cw,ch){
  if(!dragPreviewEl||!dragPreviewEl.isConnected) dragPreviewEl=makePreviewEl();
  positionPreviewEl(dragPreviewEl,r,c,o,cw,ch,valid);
}

let dragging=null;
function initBoardInteractions(){
  if(canHover){
    boardEl.addEventListener("mousemove",e=>{
      if(dragging)return;
      if(!state||!state.started){clearHoverPreview();return;}
      const{rect,cw,ch}=boardMetrics();
      const dispSlot=nearestWallSlot(e.clientX-rect.left,e.clientY-rect.top,cw,ch);
      const slot=dispSlot?wallRotate(dispSlot.r,dispSlot.c,dispSlot.o,invK(myK()),boardN()):null;
      showHoverPreview(slot,cw,ch);
    });
    boardEl.addEventListener("mouseleave",()=>{ if(!dragging) clearHoverPreview(); });
  }
  boardEl.addEventListener("click",e=>{
    if(dragging)return;
    if(!state||!state.started)return;
    const{rect,cw,ch}=boardMetrics();
    const x=e.clientX-rect.left,y=e.clientY-rect.top;
    const n=boardN(),k=myK();
    // Always try to resolve a wall gap first, regardless of the "pointer:
    // fine" hover-capability check above -- that check only decides whether
    // to show a live green/red preview while moving the mouse, but some
    // devices (hybrid touch/mouse laptops, some browsers) misreport it, which
    // used to silently disable wall placement by click entirely on those
    // devices even though a real mouse was being used.
    const dispSlot=nearestWallSlot(x,y,cw,ch);
    const slot=dispSlot?wallRotate(dispSlot.r,dispSlot.c,dispSlot.o,invK(k),n):null;
    if(slot){
      if(!myTurnNow()){sndError();return;}
      if(!clientValidWall(slot.r,slot.c,slot.o)){toast("مينفعش تحط الحاجز هنا.");sndError();return;}
      attemptPlaceWall(slot.r,slot.c,slot.o);
      return;
    }
    const dc=Math.floor(x/cw), dr=Math.floor(y/ch);
    if(dr>=0&&dr<n&&dc>=0&&dc<n){
      const[r,c]=cellRotate(dr,dc,invK(k),n);
      attemptMove(r,c);
    }
  });
}
initBoardInteractions();

/* ---------- draggable wall tiles (mouse + touch via Pointer Events) ---------- */
function setupWallTile(el,o){
  el.addEventListener("pointerdown",e=>{
    if(e.pointerType==="mouse"&&e.button!==0)return;
    if(!state||!state.started)return;
    if(!myTurnNow()){toast("لسه مش دورك.");sndError();return;}
    if(wallsLeftMine()<=0){toast("خلصت الحواجز بتاعتك.");sndError();return;}
    e.preventDefault();
    startDrag(o,e);
  });
}
function startDrag(o,e){
  clearHoverPreview();
  dragging={o,r:null,c:null,valid:false};
  const ghost=document.createElement("div");
  ghost.className="wall-ghost "+o;
  document.body.appendChild(ghost);
  dragging.ghost=ghost;
  moveGhost(e.clientX,e.clientY);
  document.addEventListener("pointermove",onDragMove);
  document.addEventListener("pointerup",onDragEnd);
  document.addEventListener("pointercancel",onDragEnd);
  boardEl.classList.add("dragging-wall");
}
function moveGhost(x,y){ if(dragging&&dragging.ghost){dragging.ghost.style.left=x+"px";dragging.ghost.style.top=y+"px";} }
function onDragMove(e){
  if(!dragging)return;
  moveGhost(e.clientX,e.clientY);
  const{rect,cw,ch}=boardMetrics();
  const x=e.clientX-rect.left,y=e.clientY-rect.top;
  if(x<0||y<0||x>rect.width||y>rect.height){
    dragging.r=null;dragging.c=null;
    clearDragPreview();
    boardEl.classList.remove("drag-over");
    return;
  }
  boardEl.classList.add("drag-over");
  const n=boardN(),wMax=n-2,k=myK();
  const dr=clamp(Math.round(y/ch)-1,0,wMax), dc=clamp(Math.round(x/cw)-1,0,wMax);
  const real=wallRotate(dr,dc,dragging.o,invK(k),n);
  dragging.r=real.r;dragging.c=real.c;dragging.realO=real.o;
  dragging.valid=clientValidWall(real.r,real.c,real.o);
  showDragPreview(real.r,real.c,real.o,dragging.valid,cw,ch);
}
function onDragEnd(e){
  if(!dragging)return;
  const d=dragging;
  document.removeEventListener("pointermove",onDragMove);
  document.removeEventListener("pointerup",onDragEnd);
  document.removeEventListener("pointercancel",onDragEnd);
  if(d.ghost) d.ghost.remove();
  clearDragPreview();
  boardEl.classList.remove("dragging-wall","drag-over");
  dragging=null;
  if(d.r!=null&&d.c!=null){
    if(d.valid) attemptPlaceWall(d.r,d.c,d.realO||d.o);
    else{ toast("مينفعش تحط الحاجز هنا.");sndError(); }
  }
}
setupWallTile($("#wallTileH"),"h");
setupWallTile($("#wallTileV"),"v");
