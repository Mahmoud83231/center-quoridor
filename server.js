const express=require("express");
const http=require("http");
const path=require("path");
const fs=require("fs");
const crypto=require("crypto");
const {Server}=require("socket.io");
const {DatabaseSync}=require("node:sqlite");

const app=express();
const server=http.createServer(app);
const io=new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(req,res)=>res.json({ok:true,service:"center-quoridor"}));

const PORT=process.env.PORT||3000;
const MAX=4,WALLS=10;
const PLAYER_TIME_MS=5*60*1000; // each player gets a 5 minute bank for the whole game (chess-clock style)
const HISTORY_CAP=200;
// Board size depends on mode: real Quoridor is 9x9 for 1v1 "classic"; the
// custom "center" mode (2-4 players racing to one shared square) keeps the
// larger 11x11 board it was designed around.
function boardSize(mode){ return mode==="classic"?9:11; }
function centerOf(mode){ return mode==="classic"?4:5; }
function startSlots(mode){
  const n=boardSize(mode),c=centerOf(mode);
  return [
    {r:0,c,color:"#20df78"},   // top
    {r:c,c:n-1,color:"#13a8ff"}, // right
    {r:n-1,c,color:"#f52b62"}, // bottom
    {r:c,c:0,color:"#ff9d0a"}  // left
  ];
}
const SLOT_ORDER_BY_COUNT={2:[0,2],3:[0,1,3],4:[0,1,2,3]};
// "classic" mode is always exactly the 2-player top/bottom pairing (slots 0
// and 2), so a slot's goal is simply the opposite edge from where it started.
function isWin(room,slot,r,c){
  if(room.mode==="classic") return room.slots[slot].r===0 ? r===room.n-1 : r===0;
  return r===room.c&&c===room.c;
}

const rooms=new Map();

/* ============================= accounts (real SQLite DB) ============================= */
const DATA_DIR=path.join(__dirname,"data");
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
const db=new DatabaseSync(path.join(DATA_DIR,"quoridor.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    key TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    banned INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL
  );
`);
// One-off migration from the old users.json flat file, if one exists and the
// DB is still empty (upgrade path for anyone running an older copy).
(function migrateLegacyJson(){
  const legacy=path.join(DATA_DIR,"users.json");
  if(!fs.existsSync(legacy))return;
  const countRow=db.prepare("SELECT COUNT(*) AS n FROM users").get();
  if(countRow.n>0)return;
  try{
    const old=JSON.parse(fs.readFileSync(legacy,"utf8"));
    const ins=db.prepare(`INSERT OR IGNORE INTO users(key,username,salt,hash,wins,games,role,banned,createdAt) VALUES(?,?,?,?,?,?,?,?,?)`);
    for(const key in old){
      const u=old[key];
      ins.run(key,u.username||key,u.salt,u.hash,u.wins||0,u.games||0,u.role==="owner"?"user":(u.role||"user"),u.banned?1:0,u.createdAt||Date.now());
    }
    fs.renameSync(legacy,legacy+".migrated");
    console.log("[migration] imported legacy users.json into SQLite");
  }catch(e){ console.error("[migration failed]",e); }
})();

const qGetUser=db.prepare("SELECT * FROM users WHERE key=?");
const qInsertUser=db.prepare(`INSERT INTO users(key,username,salt,hash,wins,games,role,banned,createdAt) VALUES(?,?,?,?,0,0,'user',0,?)`);
const qHasOwner=db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'");
const qSetRole=db.prepare("UPDATE users SET role=? WHERE key=?");
const qSetBanned=db.prepare("UPDATE users SET banned=? WHERE key=?");
const qIncGamesWins=db.prepare("UPDATE users SET games=games+?, wins=wins+? WHERE key=?");
const qSearchUsers=db.prepare("SELECT * FROM users WHERE username LIKE ? ORDER BY createdAt DESC LIMIT 100");
const qLeaderboard=db.prepare("SELECT username,wins,games FROM users WHERE games>0 ORDER BY wins DESC, (CAST(wins AS REAL)/games) DESC LIMIT 50");

// Site ownership is never handed out automatically to whoever happens to
// register first. It is only granted to the exact username configured by
// whoever deploys the server (ADMIN_USERNAME env var), and only once, so a
// random visitor can never end up owning the admin dashboard.
const ADMIN_USERNAME=(process.env.ADMIN_USERNAME||"").trim().toLowerCase();
function maybePromoteOwner(key){
  if(!ADMIN_USERNAME||key!==ADMIN_USERNAME)return;
  if(qHasOwner.get().n>0)return;
  qSetRole.run("owner",key);
}

function hashPassword(pw,salt){ return crypto.scryptSync(String(pw),salt,64).toString("hex"); }
function makeToken(){ return crypto.randomBytes(24).toString("hex"); }
function publicAccount(u){ return {username:u.username,wins:u.wins||0,games:u.games||0,createdAt:u.createdAt||null,role:u.role||"user"}; }
const sessions=new Map(); // token -> lowercase username key
function accountByToken(token){
  const key=sessions.get(String(token||""));
  return key?qGetUser.get(key):null;
}
function requireRole(token,roles){
  const u=accountByToken(token);
  if(!u||u.banned)return null;
  return roles.includes(u.role||"user")?u:null;
}

app.post("/api/register",(req,res)=>{
  const {username,password}=req.body||{};
  const uname=String(username||"").trim();
  const key=uname.toLowerCase();
  if(uname.length<3||uname.length>18) return res.status(400).json({error:"الاسم لازم يكون من 3 لـ18 حرف."});
  if(!/^[a-zA-Z0-9_\u0600-\u06FF ]+$/.test(uname)) return res.status(400).json({error:"اسم المستخدم فيه رموز غير مسموحة."});
  if(String(password||"").length<4) return res.status(400).json({error:"كلمة السر لازم تكون 4 حروف على الأقل."});
  if(qGetUser.get(key)) return res.status(400).json({error:"اسم المستخدم دا محجوز، جرب اسم تاني."});
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=hashPassword(password,salt);
  qInsertUser.run(key,uname,salt,hash,Date.now());
  maybePromoteOwner(key);
  const token=makeToken();
  sessions.set(token,key);
  res.json({token,...publicAccount(qGetUser.get(key))});
});
app.post("/api/login",(req,res)=>{
  const {username,password}=req.body||{};
  const key=String(username||"").trim().toLowerCase();
  const u=qGetUser.get(key);
  if(!u) return res.status(400).json({error:"اسم المستخدم أو كلمة السر غلط."});
  const hash=hashPassword(password,u.salt);
  const a=Buffer.from(hash,"hex"),b=Buffer.from(u.hash,"hex");
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(400).json({error:"اسم المستخدم أو كلمة السر غلط."});
  if(u.banned) return res.status(403).json({error:"الحساب ده محظور."});
  maybePromoteOwner(key);
  const token=makeToken();
  sessions.set(token,key);
  res.json({token,...publicAccount(qGetUser.get(key))});
});
app.get("/api/me",(req,res)=>{
  const u=accountByToken(req.query.token);
  if(!u) return res.status(401).json({error:"لسه مسجلتش دخول."});
  if(u.banned) return res.status(403).json({error:"الحساب ده محظور."});
  res.json(publicAccount(u));
});
app.post("/api/logout",(req,res)=>{
  sessions.delete(String((req.body||{}).token||""));
  res.json({ok:true});
});
app.get("/api/leaderboard",(req,res)=>{
  res.json(qLeaderboard.all());
});

/* ============================= site admin dashboard (owner/mod only) ============================= */
// Access requires a real DB role of "owner" or "mod" — never granted just by
// visiting /admin.html. See maybePromoteOwner() for the only way "owner" is
// ever assigned.
app.get("/api/admin/me",(req,res)=>{
  const u=requireRole(req.query.token,["owner","mod"]);
  if(!u) return res.status(403).json({error:"معندكش صلاحية."});
  res.json({username:u.username,role:u.role});
});
app.get("/api/admin/rooms",(req,res)=>{
  if(!requireRole(req.query.token,["owner","mod"])) return res.status(403).json({error:"معندكش صلاحية."});
  const list=[...rooms.values()].map(room=>({
    code:room.code,mode:room.mode,started:room.started,winner:room.winner,createdAt:room.createdAt,
    players:room.players.map(p=>({id:p.id,name:p.name,account:p.account||null,isHost:room.players[0]&&room.players[0].id===p.id}))
  })).sort((a,b)=>b.createdAt-a.createdAt);
  res.json(list);
});
app.post("/api/admin/rooms/:code/end",(req,res)=>{
  if(!requireRole((req.body||{}).token,["owner","mod"])) return res.status(403).json({error:"معندكش صلاحية."});
  const room=rooms.get(String(req.params.code||"").toUpperCase());
  if(!room) return res.status(404).json({error:"الغرفة مش موجودة."});
  forceEndRoom(room);
  res.json({ok:true});
});
app.post("/api/admin/rooms/:code/kick",(req,res)=>{
  if(!requireRole((req.body||{}).token,["owner","mod"])) return res.status(403).json({error:"معندكش صلاحية."});
  const room=rooms.get(String(req.params.code||"").toUpperCase());
  if(!room) return res.status(404).json({error:"الغرفة مش موجودة."});
  const ok=forceKickFromRoom(room,(req.body||{}).playerId);
  res.json({ok});
});
app.get("/api/admin/users",(req,res)=>{
  if(!requireRole(req.query.token,["owner","mod"])) return res.status(403).json({error:"معندكش صلاحية."});
  const q=String(req.query.q||"").trim();
  const rows=qSearchUsers.all(`%${q}%`);
  res.json(rows.map(u=>({username:u.username,wins:u.wins,games:u.games,role:u.role,banned:!!u.banned,createdAt:u.createdAt})));
});
app.post("/api/admin/users/:username/ban",(req,res)=>{
  const requester=requireRole((req.body||{}).token,["owner"]);
  if(!requester) return res.status(403).json({error:"البان بس للمالك."});
  const key=String(req.params.username||"").toLowerCase();
  const u=qGetUser.get(key);
  if(!u) return res.status(404).json({error:"المستخدم مش موجود."});
  if(u.role==="owner") return res.status(400).json({error:"مينفعش تبان المالك."});
  const banned=(req.body||{}).banned?1:0;
  qSetBanned.run(banned,key);
  if(banned){
    for(const room of rooms.values()){
      const target=room.players.find(p=>p.account===key);
      if(target) forceKickFromRoom(room,target.id);
    }
  }
  res.json({ok:true,banned:!!banned});
});
app.post("/api/admin/users/:username/role",(req,res)=>{
  const requester=requireRole((req.body||{}).token,["owner"]);
  if(!requester) return res.status(403).json({error:"تعيين المشرفين بس للمالك."});
  const key=String(req.params.username||"").toLowerCase();
  const u=qGetUser.get(key);
  if(!u) return res.status(404).json({error:"المستخدم مش موجود."});
  if(u.role==="owner") return res.status(400).json({error:"مينفعش تغيّر رتبة المالك."});
  const role=(req.body||{}).role==="mod"?"mod":"user";
  qSetRole.run(role,key);
  res.json({ok:true,role});
});

/* ============================= game logic ============================= */
function safe(fn){ return (...args)=>{ try{fn(...args);}catch(e){console.error("[handler error]",e);} }; }
function isInt(x){return typeof x==="number"&&Number.isInteger(x);}
function toIntOrNaN(x){const n=Number(x);return Number.isInteger(n)?n:NaN;}
function newCode(){ let c; do c=crypto.randomBytes(3).toString("hex").toUpperCase(); while(rooms.has(c)); return c; }
function newRoom(code,mode){
  mode=mode==="classic"?"classic":"center";
  const n=boardSize(mode),slots=startSlots(mode);
  return {
    code,mode,n,c:centerOf(mode),slots,players:[],
    positions:slots.map(x=>({r:x.r,c:x.c})),
    walls:[],wallsLeft:Array(MAX).fill(WALLS),turn:0,started:false,winner:null,
    history:[],timeLeft:Array(MAX).fill(PLAYER_TIME_MS),turnStartedAt:null,turnDeadline:null,_timer:null,
    createdAt:Date.now()
  };
}
function roomOf(s){ for(const room of rooms.values()) if(room.players.some(p=>p.id===s.id)) return room; return null; }
function inB(g,r,c){return r>=0&&r<g.n&&c>=0&&c<g.n;}
function blocks(g,r1,c1,r2,c2){
  if(r1===r2){
    const c=Math.min(c1,c2);
    return g.walls.some(w=>w.o==="v"&&w.c===c&&w.r<=r1&&r1<=w.r+1);
  }
  if(c1===c2){
    const r=Math.min(r1,r2);
    return g.walls.some(w=>w.o==="h"&&w.r===r&&w.c<=c1&&c1<=w.c+1);
  }
  return true;
}
function pawnAt(g,r,c,ignoreSlot=-1){
  for(const pl of g.players){
    if(pl.slot===ignoreSlot) continue;
    const p=g.positions[pl.slot];
    if(p.r===r&&p.c===c) return pl.slot;
  }
  return -1;
}
function legalMoves(g,slot){
  const p=g.positions[slot],out=[];
  for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){
    let nr=p.r+dr,nc=p.c+dc;
    if(!inB(g,nr,nc)||blocks(g,p.r,p.c,nr,nc)) continue;
    const occ=pawnAt(g,nr,nc,slot);
    if(occ===-1){out.push({r:nr,c:nc});continue;}
    const jr=nr+dr,jc=nc+dc;
    if(inB(g,jr,jc)&&pawnAt(g,jr,jc,slot)===-1&&!blocks(g,nr,nc,jr,jc)){
      out.push({r:jr,c:jc});continue;
    }
    const sides=dr!==0?[[0,-1],[0,1]]:[[-1,0],[1,0]];
    for(const [sr,sc] of sides){
      const ar=nr+sr,ac=nc+sc;
      if(inB(g,ar,ac)&&pawnAt(g,ar,ac,slot)===-1&&!blocks(g,nr,nc,ar,ac)) out.push({r:ar,c:ac});
    }
  }
  return out;
}
function hasPath(g,slot){
  const s=g.positions[slot],q=[s],seen=new Set([`${s.r},${s.c}`]);
  while(q.length){
    const p=q.shift();
    if(isWin(g,slot,p.r,p.c)) return true;
    for(const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){
      const nr=p.r+dr,nc=p.c+dc;
      if(!inB(g,nr,nc)||blocks(g,p.r,p.c,nr,nc)) continue;
      const k=`${nr},${nc}`;
      if(!seen.has(k)){seen.add(k);q.push({r:nr,c:nc});}
    }
  }
  return false;
}
// A new wall is only illegal if it (a) exactly overlaps/extends an existing
// wall of the same orientation, (b) crosses THROUGH an existing perpendicular
// wall at the exact same anchor point (a real "+" crossing - touching corners
// / T-junctions next to a wall are legal Quoridor placements and must stay
// allowed), or (c) would seal off any player's path to their goal.
function validWall(g,r,c,o){
  const wn=g.n-1;
  if(!["h","v"].includes(o)||r<0||c<0||r>=wn||c>=wn) return false;
  if(g.walls.some(w=>w.r===r&&w.c===c&&w.o===o)) return false;
  if(o==="h"){
    if(g.walls.some(w=>w.o==="h"&&w.r===r&&Math.abs(w.c-c)<=1)) return false;
    if(g.walls.some(w=>w.o==="v"&&w.r===r&&w.c===c)) return false;
  }else{
    if(g.walls.some(w=>w.o==="v"&&w.c===c&&Math.abs(w.r-r)<=1)) return false;
    if(g.walls.some(w=>w.o==="h"&&w.r===r&&w.c===c)) return false;
  }
  const t={...g,walls:[...g.walls,{r,c,o,player:-1}]};
  for(const pl of g.players) if(!hasPath(t,pl.slot)) return false;
  return true;
}
function pushHistory(room,entry){
  room.history.push({...entry,at:Date.now()});
  if(room.history.length>HISTORY_CAP) room.history.shift();
}
function clearTimer(room){ if(room._timer){clearTimeout(room._timer);room._timer=null;} }
// Deduct the time the current player actually used from their personal bank
// (chess-clock style: the clock only runs on a player's own turn and stops
// the instant they act, resuming from where it left off next time it's
// their turn).
function commitElapsed(room){
  if(room.turnStartedAt==null) return;
  const cur=room.players[room.turn];
  if(!cur) {room.turnStartedAt=null;return;}
  const slot=cur.slot;
  const elapsed=Date.now()-room.turnStartedAt;
  room.timeLeft[slot]=Math.max(0,(room.timeLeft[slot]??PLAYER_TIME_MS)-elapsed);
  room.turnStartedAt=null;
}
function armTimer(room){
  clearTimer(room);
  room.turnDeadline=null;
  if(!room.started||room.winner!==null||room.players.length<2) return;
  const slot=room.players[room.turn].slot;
  room.turnStartedAt=Date.now();
  const rem=Math.max(0,room.timeLeft[slot]??PLAYER_TIME_MS);
  room.turnDeadline=room.turnStartedAt+rem;
  room._timer=setTimeout(()=>autoPlay(room),rem+150);
}
function recordResult(room){
  const gamesRows=[];
  for(const pl of room.players) if(pl.account) gamesRows.push(pl.account);
  const winnerKey=room.winner!==null&&room.players[room.winner]&&room.players[room.winner].account
    ? room.players[room.winner].account : null;
  for(const key of gamesRows){
    qIncGamesWins.run(1,key===winnerKey?1:0,key);
  }
}
function autoPlay(room){
  if(!room.started||room.winner!==null) return;
  const player=room.players[room.turn];
  if(!player) return;
  commitElapsed(room);
  const slot=player.slot;
  const moves=legalMoves(room,slot);
  if(moves.length){
    const mv=moves[Math.floor(Math.random()*moves.length)];
    room.positions[slot]={r:mv.r,c:mv.c};
    pushHistory(room,{type:"move",name:player.name,color:room.slots[slot].color,r:mv.r,c:mv.c,auto:true});
    if(isWin(room,slot,mv.r,mv.c)){room.winner=room.turn;clearTimer(room);recordResult(room);}
    else{room.turn=(room.turn+1)%room.players.length;armTimer(room);}
  } else {
    room.turn=(room.turn+1)%room.players.length;armTimer(room);
  }
  send(room);
}
function pub(room){
  return {
    code:room.code,mode:room.mode,n:room.n,c:room.c,
    players:room.players.map((p,i)=>({id:p.id,name:p.name,index:i,slot:p.slot,color:room.slots[p.slot].color,account:p.account||null,isHost:i===0})),
    positions:room.positions,walls:room.walls,wallsLeft:room.wallsLeft,
    turn:room.turn,started:room.started,winner:room.winner,
    history:room.history,turnDeadline:room.turnDeadline,timeLeft:room.timeLeft,playerTimeMs:PLAYER_TIME_MS
  };
}
function send(room){io.to(room.code).emit("state",pub(room));}
function forceEndRoom(room){
  room.started=false;room.winner=null;clearTimer(room);
  room.positions=room.slots.map(x=>({r:x.r,c:x.c}));
  room.walls=[];room.wallsLeft=Array(MAX).fill(WALLS);room.turn=0;room.history=[];
  send(room);
}
function forceKickFromRoom(room,targetId){
  const target=room.players.find(p=>p.id===targetId);
  if(!target)return false;
  io.to(target.id).emit("kicked",{});
  const tSock=io.sockets.sockets.get(target.id);if(tSock)tSock.leave(room.code);
  room.players=room.players.filter(p=>p.id!==target.id);
  if(room.started){room.started=false;room.winner=null;clearTimer(room);}
  room.turn=0;send(room);
  return true;
}

io.on("connection",s=>{
  s.on("createRoom",safe(({name,token,mode})=>{
    const acc=accountByToken(token);
    const accKey=acc?sessions.get(String(token||"")):null;
    const room=newRoom(newCode(),mode);
    const finalName=acc?acc.username:(String(name||"Player 1").trim().slice(0,18)||"Player 1");
    room.players.push({id:s.id,name:finalName,slot:0,account:accKey||null});
    rooms.set(room.code,room);s.join(room.code);send(room);
  }));
  s.on("joinRoom",safe(({code,name,token})=>{
    const room=rooms.get(String(code||"").trim().toUpperCase());
    if(!room)return s.emit("errorMsg","الغرفة غير موجودة.");
    if(room.started)return s.emit("errorMsg","المباراة بدأت بالفعل.");
    const cap=room.mode==="classic"?2:MAX;
    if(room.players.length>=cap)return s.emit("errorMsg",room.mode==="classic"?"الغرفة دي 1 ضد 1 بس، مكتملة.":"الغرفة مكتملة.");
    const acc=accountByToken(token);
    const accKey=acc?sessions.get(String(token||"")):null;
    const slots=SLOT_ORDER_BY_COUNT[room.players.length+1];
    const used=new Set(room.players.map(p=>p.slot));
    const slot=slots.find(x=>!used.has(x));
    const finalName=acc?acc.username:(String(name||`Player ${room.players.length+1}`).trim().slice(0,18)||`Player ${room.players.length+1}`);
    room.players.push({id:s.id,name:finalName,slot,account:accKey||null});
    s.join(room.code);send(room);
  }));
  s.on("startGame",safe(()=>{
    const room=roomOf(s);if(!room||room.players[0].id!==s.id||room.players.length<2)return;
    room.started=true;room.turn=0;room.winner=null;room.history=[];
    room.timeLeft=Array(MAX).fill(PLAYER_TIME_MS);
    armTimer(room);send(room);
  }));
  s.on("move",safe(({r,c})=>{
    const room=roomOf(s);if(!room||!room.started||room.winner!==null)return;
    const me=room.players[room.turn];if(!me||me.id!==s.id)return;
    const rr=toIntOrNaN(r),cc=toIntOrNaN(c);
    if(!isInt(rr)||!isInt(cc)||!inB(room,rr,cc)) return s.emit("errorMsg","الحركة دي مش مسموحة.");
    const slot=me.slot;
    if(!legalMoves(room,slot).some(p=>p.r===rr&&p.c===cc)) return s.emit("errorMsg","الحركة دي مش مسموحة.");
    commitElapsed(room);
    room.positions[slot]={r:rr,c:cc};
    pushHistory(room,{type:"move",name:me.name,color:room.slots[slot].color,r:rr,c:cc});
    if(isWin(room,slot,rr,cc)){room.winner=room.turn;clearTimer(room);recordResult(room);}
    else{room.turn=(room.turn+1)%room.players.length;armTimer(room);}
    send(room);
  }));
  s.on("placeWall",safe(({r,c,o})=>{
    const room=roomOf(s);if(!room||!room.started||room.winner!==null)return;
    const me=room.players[room.turn];if(!me||me.id!==s.id)return;
    if((room.wallsLeft[room.turn]??0)<=0) return s.emit("errorMsg","خلصت الحواجز بتاعتك.");
    const rr=toIntOrNaN(r),cc=toIntOrNaN(c);
    if(!isInt(rr)||!isInt(cc)||(o!=="h"&&o!=="v")) return s.emit("errorMsg","مينفعش تحط الحاجز هنا.");
    if(!validWall(room,rr,cc,o))return s.emit("errorMsg","مينفعش تحط الحاجز هنا، إما فيه حاجز مكانه أو هيقفل الطريق على حد.");
    commitElapsed(room);
    room.walls.push({r:rr,c:cc,o,player:room.turn});
    room.wallsLeft[room.turn]--;
    pushHistory(room,{type:"wall",name:me.name,color:room.slots[me.slot].color,r:rr,c:cc,o});
    room.turn=(room.turn+1)%room.players.length;
    armTimer(room);
    send(room);
  }));
  s.on("restart",safe(()=>{
    const room=roomOf(s);if(!room||room.players[0].id!==s.id)return;
    room.positions=room.slots.map(x=>({r:x.r,c:x.c}));
    room.walls=[];room.wallsLeft=Array(MAX).fill(WALLS);room.turn=0;room.winner=null;room.started=true;
    room.timeLeft=Array(MAX).fill(PLAYER_TIME_MS);
    room.history=[];armTimer(room);send(room);
  }));
  s.on("disconnect",safe(()=>{
    const room=roomOf(s);if(!room)return;
    room.players=room.players.filter(p=>p.id!==s.id);
    if(!room.players.length){clearTimer(room);rooms.delete(room.code);return;}
    room.started=false;room.winner=null;room.turn=0;clearTimer(room);send(room);
  }));
});

server.listen(PORT,"0.0.0.0",()=>console.log(`Center Quoridor listening on port ${PORT}`));
