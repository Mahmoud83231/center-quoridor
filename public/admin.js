const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
let account=JSON.parse(localStorage.getItem("cq_account")||"null");
let myRole=null;
let pollTimer=null;

function toast(m){const t=$("#toast");t.textContent=m;t.style.display="block";clearTimeout(window.__t);window.__t=setTimeout(()=>t.style.display="none",2400);}

function showGate(err){
  $("#gate").hidden=false;$("#denied").hidden=true;$("#dash").hidden=true;$("#adminLogout").hidden=true;
  if(err){$("#gateError").hidden=false;$("#gateError").textContent=err;} else $("#gateError").hidden=true;
}
function showDenied(){
  $("#gate").hidden=true;$("#denied").hidden=false;$("#dash").hidden=true;$("#adminLogout").hidden=false;
}
function showDash(){
  $("#gate").hidden=true;$("#denied").hidden=true;$("#dash").hidden=false;$("#adminLogout").hidden=false;
  $("#whoami").textContent=`${account.username} — ${myRole==="owner"?"مالك اللعبة":"مشرف"}`;
  refreshAll();
  clearInterval(pollTimer);
  pollTimer=setInterval(refreshAll,4000);
}

async function checkAccess(){
  if(!account){showGate();return;}
  try{
    const res=await fetch(`/api/admin/me?token=${encodeURIComponent(account.token)}`);
    if(res.status===403||res.status===401){showDenied();return;}
    const d=await res.json();
    myRole=d.role;
    showDash();
  }catch(e){showGate("مشكلة في الاتصال بالسيرفر.");}
}

$("#gateSubmit").onclick=async()=>{
  const email=$("#gateEmail").value.trim(),password=$("#gatePass").value;
  if(!email||!password){$("#gateError").hidden=false;$("#gateError").textContent="اكتب البريد الإلكتروني وكلمة السر.";return;}
  try{
    const res=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password})});
    const d=await res.json();
    if(!res.ok||d.error){$("#gateError").hidden=false;$("#gateError").textContent=d.error||"حصل خطأ.";return;}
    account=d;localStorage.setItem("cq_account",JSON.stringify(account));
    checkAccess();
  }catch(e){$("#gateError").hidden=false;$("#gateError").textContent="مشكلة في الاتصال بالسيرفر.";}
};
$("#gatePass").addEventListener("keydown",e=>{if(e.key==="Enter")$("#gateSubmit").click();});
$("#adminLogout").onclick=()=>{
  clearInterval(pollTimer);
  if(account) fetch("/api/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token})}).catch(()=>{});
  account=null;localStorage.removeItem("cq_account");
  showGate();
};

function refreshAll(){ loadRooms(); loadUsers($("#userSearch").value.trim()); }

async function loadRooms(){
  try{
    const res=await fetch(`/api/admin/rooms?token=${encodeURIComponent(account.token)}`);
    if(res.status===403){showDenied();return;}
    const rooms=await res.json();
    $("#statRooms").textContent=rooms.length;
    $("#statPlayers").textContent=rooms.reduce((n,r)=>n+r.players.length,0);
    if(!rooms.length){$("#roomsList").innerHTML=`<div class="empty-note">مفيش غرف شغالة دلوقتي.</div>`;return;}
    $("#roomsList").innerHTML=rooms.map(r=>`
      <div class="room-card">
        <div class="room-card-head">
          <span class="room-code">ROOM ${esc(r.code)}</span>
          <span class="room-tags">
            <span class="tag mode">${r.mode==="classic"?"1 ضد 1":"مركز"}</span>
            <span class="tag ${r.started?"live":""}">${r.started?"شغالة":"لسه في الانتظار"}</span>
          </span>
        </div>
        <div class="room-players">
          ${r.players.map(p=>`
            <div class="room-player">
              <span class="room-player-name">${p.isHost?"👑":"•"} ${esc(p.name)}${p.account?" ✓":""}</span>
              ${p.isHost?"":`<button class="ghost" data-act="roomkick" data-code="${r.code}" data-id="${p.id}">طرد</button>`}
            </div>`).join("")||`<div class="empty-note">مفيش لاعبين متصلين.</div>`}
        </div>
        <div class="room-actions">
          <button class="ghost" data-act="roomend" data-code="${r.code}" ${r.started?"":"disabled"}>🛑 إنهاء الماتش</button>
        </div>
      </div>`).join("");
  }catch(e){}
}

async function loadUsers(q){
  try{
    const res=await fetch(`/api/admin/users?token=${encodeURIComponent(account.token)}&q=${encodeURIComponent(q||"")}`);
    if(res.status===403){showDenied();return;}
    const users=await res.json();
    $("#statUsers").textContent=users.length;
    if(!users.length){$("#usersList").innerHTML=`<div class="empty-note">مفيش نتايج.</div>`;return;}
    $("#usersList").innerHTML=users.map(u=>{
      const roleBadge=u.role==="owner"?`<span class="role-badge owner">👑 مالك</span>`
        :u.role==="mod"?`<span class="role-badge mod">🛡️ مشرف</span>`:"";
      const bannedBadge=u.banned?`<span class="role-badge banned">🚫 محظور</span>`:"";
      const canManage=myRole==="owner"&&u.role!=="owner";
      const actions=canManage?`
        <div class="user-actions">
          <button class="ghost ${u.role==="mod"?"mod-on":""}" data-act="rolemod" data-user="${esc(u.username)}" data-cur="${u.role}">${u.role==="mod"?"🛡️ إلغاء الإشراف":"🛡️ خليه مشرف"}</button>
          <button class="ghost ${u.banned?"on":""}" data-act="ban" data-user="${esc(u.username)}" data-cur="${u.banned?"1":"0"}">${u.banned?"✅ فك الحظر":"🚫 احظره"}</button>
        </div>`:"";
      return `
      <div class="user-row">
        <div class="user-row-head">
          <span class="user-name">${esc(u.username)} ${roleBadge}${bannedBadge}</span>
        </div>
        <div class="user-meta">${u.wins} فوز • ${u.games} مباراة</div>
        ${actions}
      </div>`;
    }).join("");
  }catch(e){}
}

document.addEventListener("click",async e=>{
  const btn=e.target.closest("[data-act]");
  if(!btn||btn.disabled)return;
  const act=btn.dataset.act;
  try{
    if(act==="roomkick"){
      if(!confirm("متأكد إنك عايز تطرد اللاعب ده؟"))return;
      await fetch(`/api/admin/rooms/${btn.dataset.code}/kick`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token,playerId:btn.dataset.id})});
      toast("اتطرد.");loadRooms();
    }else if(act==="roomend"){
      if(!confirm("متأكد إنك عايز تنهي الماتش ده؟"))return;
      await fetch(`/api/admin/rooms/${btn.dataset.code}/end`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token})});
      toast("اتنهت.");loadRooms();
    }else if(act==="ban"){
      const makeBanned=btn.dataset.cur!=="1";
      if(makeBanned&&!confirm(`متأكد إنك عايز تحظر ${btn.dataset.user}؟`))return;
      const res=await fetch(`/api/admin/users/${encodeURIComponent(btn.dataset.user)}/ban`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token,banned:makeBanned})});
      const d=await res.json();
      if(!res.ok||d.error){toast(d.error||"حصل خطأ.");return;}
      toast(makeBanned?"اتحظر.":"اتفك حظره.");loadUsers($("#userSearch").value.trim());
    }else if(act==="rolemod"){
      const makeMod=btn.dataset.cur!=="mod";
      const res=await fetch(`/api/admin/users/${encodeURIComponent(btn.dataset.user)}/role`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:account.token,role:makeMod?"mod":"user"})});
      const d=await res.json();
      if(!res.ok||d.error){toast(d.error||"حصل خطأ.");return;}
      toast(makeMod?"بقى مشرف.":"اتشال من الإشراف.");loadUsers($("#userSearch").value.trim());
    }
  }catch(e){toast("مشكلة في الاتصال بالسيرفر.");}
});

let searchDebounce=null;
$("#userSearch").addEventListener("input",()=>{
  clearTimeout(searchDebounce);
  searchDebounce=setTimeout(()=>loadUsers($("#userSearch").value.trim()),280);
});

checkAccess();
