(function () {
"use strict";

// Keep --app-vh pinned to the actual visible viewport height (not the
// address-bar-collapsed max height that 100dvh can lag behind on some
// Android builds, which left scrollable panes with stale scroll metrics).
function syncAppVh() {
  var h = (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.01;
  document.documentElement.style.setProperty("--app-vh", h + "px");
}
syncAppVh();
window.addEventListener("resize", syncAppVh);
window.addEventListener("orientationchange", syncAppVh);
if (window.visualViewport) window.visualViewport.addEventListener("resize", syncAppVh);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("/sw.js").catch(function(){});
  });
}

var CHAR_COLORS = ["#e8a33d","#4fa8a0","#c97b8e","#7c8cc9","#9bb05a","#cf9bd6","#e07b54","#5fa8d4"];
var TAG_PALETTE = ["#e8a33d","#4fa8a0","#c97b8e","#7c8cc9","#9bb05a","#cf9bd6"];

var state = {
  theme: localStorage.getItem("ledger-theme") || "dark",
  user: null,
  characters: [],
  characterId: "__all__",
  notes: {},
  selectedId: null,
  search: "",
  activeTags: new Set(),
  view: "notes",
  calMode: "month",
  calAnchor: new Date(),
  calSelected: null,
  calReminders: [],
  calAllNotes: {},
  isAdmin: false,
  canAccessBills: false,
  bills: [],
  selectedBillId: null,
  billMathOpen: false
};

var saveTimers = {};
var saveStatus = {};
var charDropdownOpen = false;
var pendingAction = null; // {type: 'deleteNote'|'clearNotes'|'deleteChar', id?}
var billCategoriesDraft = [];
var pendingResetAccountId = null;
var editingCharId = null;

document.documentElement.setAttribute("data-theme", state.theme);

// ---------- utils ----------
function esc(s) { var d = document.createElement("div"); d.textContent = s||""; return d.innerHTML; }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function tagColor(t) { var s=0; for(var i=0;i<t.length;i++) s+=t.charCodeAt(i); return TAG_PALETTE[s%TAG_PALETTE.length]; }
function relTime(ts) {
  if(!ts) return "";
  var d=Date.now()-ts, m=Math.floor(d/60000);
  if(m<1) return "just now"; if(m<60) return m+"m ago";
  var h=Math.floor(m/60); if(h<24) return h+"h ago";
  var dy=Math.floor(h/24); if(dy<7) return dy+"d ago";
  return new Date(ts).toLocaleDateString(undefined,{month:"short",day:"numeric"});
}
function snippet(body) {
  var s=(body||"").replace(/[#*_`>~-]/g,"").replace(/\s+/g," ").trim();
  return s.length>85?s.slice(0,85)+"…":s;
}
function wc(body) { var t=(body||"").trim(); return t?t.split(/\s+/).length:0; }
function showToast(msg) {
  var t=document.getElementById("toast");
  t.textContent=msg; t.classList.remove("hidden");
  setTimeout(function(){t.classList.add("hidden");},2000);
}

// ---------- API ----------
function api(url, opts) {
  return fetch(url, Object.assign({headers:{"Content-Type":"application/json"}}, opts))
    .then(function(r){
      if(r.status===401){showLogin();throw new Error("unauth");}
      if(!r.ok){
        return r.json().catch(function(){return {};}).then(function(body){
          var msg = (body && body.error) || "Something went wrong. Try again.";
          showToast(msg);
          throw new Error(msg);
        });
      }
      return r.status===204?null:r.json();
    });
}

// ---------- Auth ----------
function showLogin() {
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("mustChangePasswordScreen").classList.add("hidden");
  document.getElementById("localLoginPane").classList.add("hidden");
  document.getElementById("discordLoginPane").classList.remove("hidden");
  document.getElementById("app").classList.remove("ready");
}
function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.add("ready");
}

// ---------- First-visit onboarding tour ----------
// Shown once over the login screen for brand-new visitors, gated by a
// localStorage flag. Copy is verbatim from the design handoff.
var ONBOARD_SLIDES = [
  {type:"welcome", eyebrow:"WELCOME", title:"Welcome to Ledger", desc:"A private space for character notes, a calendar, and bill tracking. Here's a quick look at what you can do."},
  {type:"notes", eyebrow:"NOTES", title:"Organize by character", desc:"Write plain text or Markdown notes and group them by character. Pin sticky notes, tag and search freely, and blur spoiler notes until you're ready to see them."},
  {type:"calendar", eyebrow:"CALENDAR", title:"See what's coming up", desc:"Month and week views show every due note, reminder, and bill. Click a day to create a note with its due date already filled in."},
  {type:"bills", eyebrow:"BILLS", title:"Never miss a due date", desc:"Track recurring bills with priority-based color coding, get a 12-month forecast of what's actually due, and a breakdown of exactly how each total is calculated."},
  {type:"budget", eyebrow:"BUDGET", title:"Envelope budgeting, made simple", desc:"Set monthly targets seeded straight from your bills. Paid bills count automatically, and any overspend or underspend rolls into next month."},
  {type:"discord", eyebrow:"DISCORD", title:"Reminders where you already are", desc:"Send notes to your own Discord DMs, schedule one-time or repeating reminders, and get an optional digest summarizing what's due."},
  {type:"local", eyebrow:"NO DISCORD? NO PROBLEM", title:"Local accounts, too", desc:"An admin can invite anyone with just a username and password. Set your own password on first login and you're in."}
];
var onboardSlide = 0;

function onboardSeen() {
  try { return !!localStorage.getItem("ledger_onboarding_seen"); } catch(e){ return false; }
}
function markOnboardSeen() {
  try { localStorage.setItem("ledger_onboarding_seen", "1"); } catch(e){}
}

function onboardVisual(type) {
  if(type==="welcome"){
    return '<span style="font-size:56px;color:var(--accent);font-family:\'IBM Plex Mono\',monospace;">¶</span>';
  }
  if(type==="notes"){
    return '<div class="onboard-mock" style="width:340px;">'+
      '<div class="onboard-mock-char"><span class="onboard-mock-dot"></span><span class="onboard-mock-charname">Elena Voss</span></div>'+
      '<div class="onboard-mock-note"><div class="onboard-mock-note-title">The Fractured Crown — ch. 4</div><div class="onboard-mock-note-snippet">She hadn\'t meant to open the letter…</div></div>'+
      '<div class="onboard-mock-note"><div class="onboard-mock-note-title">Character backstory</div><div class="onboard-mock-note-snippet">Born in the northern reaches…</div></div>'+
    '</div>';
  }
  if(type==="calendar"){
    var cells = "";
    for(var i=0;i<35;i++){
      var day = i-2;
      var valid = day>=1 && day<=31;
      var marked = valid && [3,11,18,24].indexOf(day)>-1;
      var bg = marked ? "var(--accent)" : (valid ? "var(--surface)" : "transparent");
      var color = marked ? "var(--accent-ink)" : "var(--ink-mid)";
      cells += '<div class="onboard-cal-cell" style="background:'+bg+';color:'+color+';">'+(valid?day:"")+'</div>';
    }
    return '<div class="onboard-mock" style="width:300px;">'+
      '<div class="onboard-mock-monthlabel">JULY</div>'+
      '<div class="onboard-cal-grid">'+cells+'</div>'+
    '</div>';
  }
  if(type==="bills"){
    var heights = [40,55,30,70,45,60,35,80,50,65,42,58];
    var bars = heights.map(function(h,i){
      return '<div class="onboard-bar" style="height:'+h+'%;background:'+(i===7?"var(--accent)":"var(--border)")+';"></div>';
    }).join("");
    return '<div class="onboard-mock" style="width:320px;padding:16px;">'+
      '<div class="onboard-mock-forecast-label">12-MONTH FORECAST</div>'+
      '<div class="onboard-bars">'+bars+'</div>'+
    '</div>';
  }
  if(type==="budget"){
    return '<svg width="72" height="72" viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="14" rx="2" stroke="var(--accent)" stroke-width="1.4"></rect><path d="M2 10h20" stroke="var(--accent)" stroke-width="1.4"></path><circle cx="12" cy="15" r="2.2" stroke="var(--accent)" stroke-width="1.4"></circle></svg>';
  }
  if(type==="discord"){
    return '<svg width="72" height="72" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="12" rx="4" stroke="var(--accent)" stroke-width="1.4"></rect><path d="M8 21l3-4h2l3 4" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round"></path><circle cx="9" cy="11" r="1.1" fill="var(--accent)"></circle><circle cx="15" cy="11" r="1.1" fill="var(--accent)"></circle></svg>';
  }
  if(type==="local"){
    return '<svg width="72" height="72" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="8" r="4.3" stroke="var(--accent)" stroke-width="1.4"></circle><path d="M11 11l9 9M16 16l3-3M18.5 18.5l2-2" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round"></path></svg>';
  }
  return "";
}

function renderOnboarding() {
  var card = document.getElementById("onboardCard");
  var cur = ONBOARD_SLIDES[onboardSlide];
  var isLast = onboardSlide === ONBOARD_SLIDES.length-1;
  var isFirst = onboardSlide === 0;

  var dots = ONBOARD_SLIDES.map(function(s,i){
    return '<button class="onboard-dot'+(i===onboardSlide?" active":"")+'" data-onboard-goto="'+i+'" aria-label="Go to slide '+(i+1)+'"></button>';
  }).join("");

  card.innerHTML =
    '<button class="onboard-skip" id="onboardSkip">Skip</button>'+
    '<div class="onboard-inner">'+
      '<div class="onboard-visual">'+onboardVisual(cur.type)+'</div>'+
      '<div class="onboard-copy">'+
        '<div class="onboard-eyebrow">'+esc(cur.eyebrow)+'</div>'+
        '<h2 class="onboard-title">'+esc(cur.title)+'</h2>'+
        '<p class="onboard-desc">'+esc(cur.desc)+'</p>'+
      '</div>'+
      '<div class="onboard-dots">'+dots+'</div>'+
      '<div class="onboard-footer">'+
        '<button class="onboard-back" id="onboardBack"'+(isFirst?" disabled":"")+'>← Back</button>'+
        '<div class="onboard-step">STEP '+(onboardSlide+1)+' OF '+ONBOARD_SLIDES.length+'</div>'+
        '<button class="onboard-next" id="onboardNext">'+(isLast?"Get started":"Next")+'</button>'+
      '</div>'+
    '</div>';

  document.getElementById("onboardSkip").addEventListener("click", dismissOnboarding);
  document.getElementById("onboardBack").addEventListener("click", function(){
    if(onboardSlide>0){ onboardSlide--; renderOnboarding(); }
  });
  document.getElementById("onboardNext").addEventListener("click", function(){
    if(onboardSlide >= ONBOARD_SLIDES.length-1){ dismissOnboarding(); return; }
    onboardSlide++; renderOnboarding();
  });
  card.querySelectorAll("[data-onboard-goto]").forEach(function(btn){
    btn.addEventListener("click", function(){
      onboardSlide = Number(btn.getAttribute("data-onboard-goto"));
      renderOnboarding();
    });
  });
}

function dismissOnboarding() {
  markOnboardSeen();
  document.getElementById("onboardOverlay").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("onboard-open");
}

function maybeShowOnboarding() {
  if(onboardSeen()) return;
  onboardSlide = 0;
  document.getElementById("loginScreen").classList.add("onboard-open");
  document.getElementById("onboardOverlay").classList.remove("hidden");
  renderOnboarding();
}

// ---------- Boot ----------
function boot() {
  api("/api/me").then(function(user){
    state.user=user;
    state.isAdmin=user.isAdmin===true;
    state.canAccessBills=user.canAccessBills===true;
    if(state.canAccessBills){
      document.getElementById("tabBills").classList.remove("hidden");
      document.getElementById("tabBudget").classList.remove("hidden");
    }
    refreshAddButton();
    var billCatSection=document.getElementById("billCategoriesSection");
    if(billCatSection) billCatSection.classList.toggle("hidden", !state.canAccessBills);
    document.getElementById("settingsAdminGroup").classList.toggle("hidden", !state.isAdmin);
    var changePwSection=document.getElementById("changePasswordSection");
    if(changePwSection) changePwSection.classList.toggle("hidden", user.authType!=="local");
    var digestSection=document.getElementById("discordDigestSection");
    var digestEmptyNote=document.getElementById("discordDigestEmptyNote");
    if(digestSection) digestSection.classList.toggle("hidden", user.authType!=="discord");
    if(digestEmptyNote) digestEmptyNote.classList.toggle("hidden", user.authType==="discord");
    if(user.mustChangePassword){
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("mustChangePasswordScreen").classList.remove("hidden");
      return null;
    }
    document.getElementById("mustChangePasswordScreen").classList.add("hidden");
    return api("/api/characters").then(function(chars){
      state.characters=chars||[];
      return loadNotes();
    }).then(function(){
      showApp();
      render();
    });
  }).catch(function(){
    // Not logged in: the login screen stays up. First-time visitors get the tour.
    maybeShowOnboarding();
  });
}

function loadNotes() {
  return api("/api/notes?characterId="+encodeURIComponent(state.characterId))
    .then(function(arr){
      state.notes={};
      (arr||[]).forEach(function(n){state.notes[n.id]=n;});
    });
}

// ---------- Local (non-Discord) login ----------
document.getElementById("showLocalLoginBtn").addEventListener("click",function(){
  document.getElementById("discordLoginPane").classList.add("hidden");
  document.getElementById("localLoginPane").classList.remove("hidden");
  document.getElementById("localLoginUsername").focus();
});
document.getElementById("showDiscordLoginBtn").addEventListener("click",function(){
  document.getElementById("localLoginPane").classList.add("hidden");
  document.getElementById("discordLoginPane").classList.remove("hidden");
});

function submitLocalLogin() {
  var username=document.getElementById("localLoginUsername").value.trim();
  var password=document.getElementById("localLoginPassword").value;
  if(!username||!password){ showToast("Enter a username and password"); return; }
  api("/auth/local-login",{method:"POST",body:JSON.stringify({username:username,password:password})})
    .then(function(){ window.location.reload(); })
    .catch(function(){});
}
document.getElementById("localLoginSubmit").addEventListener("click",submitLocalLogin);
document.getElementById("localLoginPassword").addEventListener("keydown",function(e){
  if(e.key==="Enter") submitLocalLogin();
});

function submitPasswordChange() {
  var current=document.getElementById("mcpCurrentPassword").value;
  var next=document.getElementById("mcpNewPassword").value;
  var confirm=document.getElementById("mcpConfirmPassword").value;
  if(next.length<8){ showToast("New password must be at least 8 characters"); return; }
  if(next!==confirm){ showToast("New passwords don't match"); return; }
  api("/api/me/password",{method:"PUT",body:JSON.stringify({currentPassword:current,newPassword:next})})
    .then(function(){
      showToast("Password set");
      boot();
    })
    .catch(function(){});
}
document.getElementById("mcpSubmit").addEventListener("click",submitPasswordChange);
document.getElementById("mcpConfirmPassword").addEventListener("keydown",function(e){
  if(e.key==="Enter") submitPasswordChange();
});

// ---------- current character obj ----------
function currentChar() {
  if(state.characterId==="__all__") return null;
  return state.characters.find(function(c){return c.id===state.characterId;})||null;
}

// ---------- Note mutations ----------
function createNote() {
  var charId = state.characterId==="__all__" ? null : state.characterId;
  api("/api/notes",{method:"POST",body:JSON.stringify({title:"",body:"",tags:[],characterId:charId})})
    .then(function(note){
      state.notes[note.id]=note;
      state.selectedId=note.id;
      render();
      document.getElementById("app").classList.add("show-editor");
      var el=document.getElementById("titleInput");
      if(el) el.focus();
    });
}

function scheduleSave(note) {
  saveStatus[note.id]="saving";
  renderStatus();
  clearTimeout(saveTimers[note.id]);
  saveTimers[note.id]=setTimeout(function(){
    api("/api/notes/"+note.id,{method:"PUT",body:JSON.stringify({title:note.title,body:note.body,tags:note.tags,sticky:note.sticky,spoiler:note.spoiler,dueDate:note.dueDate||null})})
      .then(function(updated){
        saveStatus[note.id]="saved";
        note.prevTitle=updated.prevTitle; note.prevBody=updated.prevBody; note.prevSavedAt=updated.prevSavedAt;
        renderStatus();
        updateRestoreBtnVisibility(note);
      })
      .catch(function(){saveStatus[note.id]="error"; renderStatus();});
  },500);
}

function updateRestoreBtnVisibility(note) {
  if(state.selectedId!==note.id) return;
  var btn=document.getElementById("restorePrevBtn");
  if(!btn) return;
  btn.classList.toggle("hidden", note.prevBody==null && note.prevTitle==null);
}

function restoreNoteVersion(id) {
  api("/api/notes/"+id+"/restore-previous",{method:"POST"}).then(function(note){
    state.notes[id]=note;
    if(state.selectedId===id) renderEditor();
    renderList();
    showToast("Restored previous version");
  }).catch(function(){});
}

function deleteNote(id) {
  api("/api/notes/"+id,{method:"DELETE"}).then(function(){
    delete state.notes[id];
    if(state.selectedId===id){state.selectedId=null;}
    document.getElementById("app").classList.remove("show-editor");
    render();
    showToast("Note deleted");
  });
}

function clearNotes() {
  api("/api/notes?characterId="+encodeURIComponent(state.characterId),{method:"DELETE"}).then(function(){
    state.notes={};
    state.selectedId=null;
    document.getElementById("app").classList.remove("show-editor");
    render();
    showToast("Notes cleared");
  });
}

// ---------- Character mutations ----------
function selectCharacter(id) {
  state.characterId=id;
  state.selectedId=null;
  state.activeTags=new Set();
  state.search="";
  document.getElementById("searchInput").value="";
  closeCharDropdown();
  loadNotes().then(function(){render();});
  document.getElementById("app").classList.remove("show-editor");
}

function addCharacter() {
  var name=document.getElementById("newCharInput").value.trim();
  var color=document.getElementById("newCharColor").value;
  if(!name) return;
  api("/api/characters",{method:"POST",body:JSON.stringify({name:name,color:color})})
    .then(function(c){
      state.characters.push(c);
      document.getElementById("newCharInput").value="";
      renderCharDropdown();
    });
}

function deleteCharacter(id) {
  api("/api/characters/"+id,{method:"DELETE"}).then(function(){
    state.characters=state.characters.filter(function(c){return c.id!==id;});
    if(state.characterId===id){
      state.characterId="__all__";
      state.selectedId=null;
      loadNotes().then(render);
    } else {
      renderCharDropdown();
      renderCharBar();
    }
    showToast("Character deleted");
  });
}

function openCharEdit(id) {
  var c=state.characters.find(function(x){return x.id===id;});
  if(!c) return;
  editingCharId=id;
  document.getElementById("charEditName").value=c.name;
  var colorRow=document.getElementById("charEditColors");
  colorRow.innerHTML=CHAR_COLORS.map(function(col){
    return '<button class="color-swatch'+(c.color===col?" selected":"")+'" data-color="'+col+'" style="background:'+col+'" aria-label="'+col+'"></button>';
  }).join("");
  colorRow.querySelectorAll(".color-swatch").forEach(function(btn){
    btn.addEventListener("click",function(){
      colorRow.querySelectorAll(".color-swatch").forEach(function(b){b.classList.remove("selected");});
      btn.classList.add("selected");
    });
  });
  closeCharDropdown();
  document.getElementById("charEditOverlay").classList.remove("hidden");
  document.getElementById("charEditName").focus();
}

function saveCharEdit() {
  if(!editingCharId) return;
  var name=document.getElementById("charEditName").value.trim();
  if(!name) return;
  var selected=document.querySelector("#charEditColors .color-swatch.selected");
  var color=selected?selected.getAttribute("data-color"):CHAR_COLORS[0];
  api("/api/characters/"+editingCharId,{method:"PUT",body:JSON.stringify({name:name,color:color})})
    .then(function(c){
      var idx=state.characters.findIndex(function(x){return x.id===c.id;});
      if(idx>-1) state.characters[idx]=c;
      document.getElementById("charEditOverlay").classList.add("hidden");
      editingCharId=null;
      renderCharDropdown();
      renderCharBar();
      renderList();
    });
}

// ---------- Confirm ----------
function openConfirm(text, action) {
  pendingAction=action;
  document.getElementById("confirmText").textContent=text;
  document.getElementById("confirmOverlay").classList.remove("hidden");
}
function closeConfirm() {
  pendingAction=null;
  document.getElementById("confirmOverlay").classList.add("hidden");
}

// ---------- Render ----------
function render() {
  renderThemeIcon();
  renderUserRow();
  renderCharBar();
  renderCharDropdown();
  renderTagRow();
  renderList();
  renderEditor();
}

function renderThemeIcon() {
  var btn=document.getElementById("themeToggle");
  if(state.theme==="dark") {
    btn.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  } else {
    btn.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
}

function renderUserRow() {
  var row=document.getElementById("userRow");
  if(!state.user){row.innerHTML="";return;}
  var img=state.user.avatar
    ?'<img src="'+esc(state.user.avatar)+'" alt="" />'
    :'<div class="avatar-fallback">'+esc((state.user.username||"?")[0].toUpperCase())+'</div>';
  row.innerHTML=img+'<span class="user-name">'+esc(state.user.username)+'</span>';
}

function renderCharBar() {
  var c=currentChar();
  var dot=document.getElementById("charDot");
  var label=document.getElementById("charNameLabel");
  if(c){
    dot.style.background=c.color;
    dot.style.display="block";
    label.textContent=c.name;
  } else {
    dot.style.display="none";
    label.textContent="All notes";
  }
}

function renderCharDropdown() {
  var list=document.getElementById("charList");
  // "All notes" option
  var allHtml='<div class="char-option'+(state.characterId==="__all__"?" active":"")+'" data-id="__all__" role="button" tabindex="0">'+
    '<span class="char-dot" style="background:var(--ink-dim)"></span>'+
    '<span class="char-option-name">All notes</span>'+
    '</div>';
  var charsHtml=state.characters.map(function(c){
    var active=state.characterId===c.id;
    return '<div class="char-option'+(active?" active":"")+'" data-id="'+c.id+'" role="button" tabindex="0">'+
      '<span class="char-dot" style="background:'+c.color+'"></span>'+
      '<span class="char-option-name">'+esc(c.name)+'</span>'+
      '<span class="char-option-actions">'+
        '<button class="char-action-btn" data-edit="'+c.id+'" title="Edit">'+
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'+
        '</button>'+
        '<button class="char-action-btn del" data-del="'+c.id+'" title="Delete">'+
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>'+
        '</button>'+
      '</span>'+
    '</div>';
  }).join("");
  list.innerHTML=allHtml+charsHtml;

  // color preview on picker
  var colorPick=document.getElementById("newCharColor");
  var colorWrap=document.getElementById("newCharColorWrap");
  colorWrap.style.background=colorPick.value;
  colorPick.addEventListener("input",function(){colorWrap.style.background=colorPick.value;});

  list.querySelectorAll(".char-option[data-id]").forEach(function(btn){
    btn.addEventListener("click",function(){selectCharacter(btn.getAttribute("data-id"));});
  });
  list.querySelectorAll("[data-edit]").forEach(function(btn){
    btn.addEventListener("click",function(e){e.stopPropagation();openCharEdit(btn.getAttribute("data-edit"));});
  });
  list.querySelectorAll("[data-del]").forEach(function(btn){
    btn.addEventListener("click",function(e){
      e.stopPropagation();
      var id=btn.getAttribute("data-del");
      var c=state.characters.find(function(x){return x.id===id;});
      openConfirm("Delete character \""+(c?c.name:"")+"\" and all their notes? The notes can be restored from Settings for 30 days; the character itself can't.",{type:"deleteChar",id:id});
    });
  });
}

function openCharDropdown() {
  charDropdownOpen=true;
  document.getElementById("charDropdown").classList.remove("hidden");
  renderCharDropdown();
  setTimeout(function(){document.getElementById("newCharInput").focus();},50);
}
function closeCharDropdown() {
  charDropdownOpen=false;
  document.getElementById("charDropdown").classList.add("hidden");
}

function getFiltered() {
  var arr=Object.values(state.notes);
  var q=state.search.trim().toLowerCase();
  if(q) arr=arr.filter(function(n){
    return (n.title||"").toLowerCase().indexOf(q)>-1||
           (n.body||"").toLowerCase().indexOf(q)>-1||
           n.tags.some(function(t){return t.indexOf(q)>-1;});
  });
  if(state.activeTags.size) arr=arr.filter(function(n){
    return n.tags.some(function(t){return state.activeTags.has(t);});
  });
  arr.sort(function(a,b){
    if(a.sticky!==b.sticky) return a.sticky?-1:1;
    return b.updatedAt-a.updatedAt;
  });
  return arr;
}

function allTags() {
  var set=new Set();
  Object.values(state.notes).forEach(function(n){n.tags.forEach(function(t){set.add(t);});});
  return Array.from(set).sort();
}

function renderTagRow() {
  var row=document.getElementById("tagRow");
  var tags=allTags();
  if(!tags.length){row.innerHTML="";return;}
  row.innerHTML=tags.map(function(t){
    var a=state.activeTags.has(t);
    return '<button class="tag-chip'+(a?" active":"")+'" data-tag="'+esc(t)+'">'+esc(t)+'</button>';
  }).join("");
  row.querySelectorAll(".tag-chip").forEach(function(btn){
    btn.addEventListener("click",function(){
      var t=btn.getAttribute("data-tag");
      if(state.activeTags.has(t)) state.activeTags.delete(t); else state.activeTags.add(t);
      renderTagRow(); renderList();
    });
  });
}

function renderList() {
  var list=document.getElementById("noteList");
  if(!Object.keys(state.notes).length){
    list.innerHTML='<div class="empty-list">No notes yet.<br>Hit "+ Add note" to start.</div>'; return;
  }
  var filtered=getFiltered();
  if(!filtered.length){list.innerHTML='<div class="empty-list">No notes match.</div>'; return;}

  function noteCardHtml(n, borderColor) {
    var active=n.id===state.selectedId;
    var titleHtml=n.title
      ?'<span class="note-card-title">'+esc(n.title)+'</span>'
      :'<span class="note-card-title untitled">Untitled</span>';
    var pinHtml=n.sticky?'<span class="note-card-pin" title="Sticky">📌</span>':'';
    var spoilerHtml=n.spoiler?'<span class="note-card-spoiler" title="Spoiler (open the note to view)">🙈</span>':'';
    var tagsHtml=n.tags.slice(0,3).map(function(t){
      return '<span style="color:'+tagColor(t)+'">#'+esc(t)+'</span>';
    }).join(" ");
    var trashSvg='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    return '<div class="note-card'+(active?" active":"")+(n.spoiler?" spoiler":"")+'" data-id="'+n.id+'"'+
      (borderColor?' style="border-left-color:'+borderColor+'"':'')+'>'+
      '<div class="note-card-header">'+spoilerHtml+pinHtml+titleHtml+
        '<button class="note-card-delete" data-delete-id="'+n.id+'" aria-label="Delete note" title="Delete note">'+trashSvg+'</button>'+
      '</div>'+
      '<p class="note-card-snippet">'+(esc(snippet(n.body))||"No content yet")+'</p>'+
      '<div class="note-card-meta"><span>'+relTime(n.updatedAt)+'</span>'+
      '<div class="note-card-tags">'+tagsHtml+'</div></div></div>';
  }

  if(state.characterId !== "__all__") {
    // Single character view — flat list with colored left border
    var c=currentChar();
    var borderColor=c?c.color:(filtered[0]&&filtered[0].tags.length?tagColor(filtered[0].tags[0]):"var(--border)");
    list.innerHTML=filtered.map(function(n){ return noteCardHtml(n, c?c.color:(n.tags.length?tagColor(n.tags[0]):"var(--border)")); }).join("");
  } else {
    // All notes view — group by character
    // Build ordered groups: named characters first (in order), then uncategorized
    var groups=[];
    var byChar={};

    // Initialize groups in character order
    state.characters.forEach(function(c){
      byChar[c.id]=[];
      groups.push({char:c, notes:byChar[c.id]});
    });
    var uncategorized=[];

    filtered.forEach(function(n){
      if(n.characterId && byChar[n.characterId]){
        byChar[n.characterId].push(n);
      } else {
        uncategorized.push(n);
      }
    });

    // Add uncategorized at end if any exist
    if(uncategorized.length){
      groups.push({char:null, notes:uncategorized});
    }

    // Remove empty groups
    groups=groups.filter(function(g){return g.notes.length>0;});

    list.innerHTML=groups.map(function(g){
      var c=g.char;
      var color=c?c.color:"var(--ink-dim)";
      var label=c?esc(c.name):"Uncategorized";
      var cardsHtml=g.notes.map(function(n){ return noteCardHtml(n, null); }).join("");
      return '<div class="char-group">'+
        '<div class="char-group-header">'+
          '<div class="char-group-line"></div>'+
          '<div class="char-group-label">'+
            '<span class="char-group-dot" style="background:'+color+'"></span>'+
            label+
          '</div>'+
          '<div class="char-group-line"></div>'+
        '</div>'+
        '<div class="char-group-cards" style="border-left-color:'+color+'">'+
          cardsHtml+
        '</div>'+
      '</div>';
    }).join("");
  }

  list.querySelectorAll(".note-card").forEach(function(card){
    card.addEventListener("click",function(){
      state.selectedId=card.getAttribute("data-id");
      render();
      document.getElementById("app").classList.add("show-editor");
    });
  });
  list.querySelectorAll(".note-card-delete").forEach(function(btn){
    btn.addEventListener("click",function(e){
      e.stopPropagation();
      var id=btn.getAttribute("data-delete-id");
      var note=state.notes[id];
      if(e.shiftKey){
        deleteNote(id); // skip confirm
      } else {
        openConfirm("Delete \""+(note&&note.title||"Untitled")+"\"? You can restore it from Settings for 30 days.",{type:"deleteNote",id:id});
      }
    });
  });
}

function renderEditor() {
  var editor=document.getElementById("editor");
  var note=state.notes[state.selectedId];
  if(!note){
    editor.innerHTML='<div class="editor-placeholder">Select a note or create one.</div>';
    return;
  }
  var statusText={saving:"Saving…",saved:"Saved",error:"Error saving"}[saveStatus[note.id]]||"";
  var tagChips=note.tags.map(function(t){
    return '<span class="tag-chip-edit" style="color:'+tagColor(t)+'">#'+esc(t)+
      '<button data-remove-tag="'+esc(t)+'" aria-label="Remove">×</button></span>';
  }).join("");
  var isLocalAccount = state.user && state.user.authType==="local";

  editor.innerHTML=
    '<div class="editor-head">'+
      '<div class="editor-toprow">'+
        '<button class="icon-btn back-btn" id="backBtn" aria-label="Back">'+
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'+
        '</button>'+
        '<input class="title-input" id="titleInput" placeholder="Untitled" value="'+esc(note.title)+'" />'+
      '</div>'+
      '<div class="tag-editor" id="tagEditor">'+tagChips+
        '<input class="tag-input" id="tagInput" placeholder="+ tag" />'+
      '</div>'+
      '<div class="due-date-row">'+
        '<span class="due-date-label">DUE</span>'+
        '<input type="date" class="due-date-input" id="dueDateInput"'+(note.dueDate?' value="'+note.dueDate+'"':'')+' />'+
        (note.dueDate?'<button class="due-date-clear" id="dueDateClear" title="Clear due date">×</button>':'')+
      '</div>'+
      '<div class="editor-statusrow">'+
        '<div class="status-line" id="statusLine">'+wc(note.body)+' words'+(statusText?' · '+statusText:'')+
        '</div>'+
        '<div class="editor-actions">'+
          '<button class="editor-action-btn'+(note.prevBody==null&&note.prevTitle==null?' hidden':'')+'" id="restorePrevBtn" title="Restore the version saved right before this one">↺ Restore previous</button>'+
          '<button class="editor-action-btn sticky-toggle'+(note.sticky?' active':'')+'" id="stickyBtn" title="'+(note.sticky?'Unpin note':'Pin note across characters')+'">📌 '+(note.sticky?'Pinned':'Pin')+'</button>'+
          '<button class="editor-action-btn spoiler-toggle'+(note.spoiler?' active':'')+'" id="spoilerBtn" title="'+(note.spoiler?'Remove spoiler blur':'Blur this note in the list (open it to view)')+'">🙈 '+(note.spoiler?'Spoilered':'Spoiler')+'</button>'+
          '<button class="editor-action-btn'+(isLocalAccount?' hidden':'')+'" id="sendDmBtn" title="Send note to Discord DMs">'+
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.2 14.2 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.927 1.793 8.18 1.793 12.061 0a.073.073 0 0 1 .079.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.001-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.028M8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.955 2.418-2.157 2.418m7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418"/></svg>'+
            ' Send to DMs'+
          '</button>'+
          '<button class="editor-action-btn'+(isLocalAccount?' hidden':'')+'" id="reminderBtn" title="Set a reminder">'+
            '🔔 Remind me'+
          '</button>'+
        '</div>'+
      '</div>'+
    '</div>'+
    '<div class="editor-body">'+
      '<div class="editor-pane" id="editorPane">'+
        '<textarea class="body-textarea" id="bodyTextarea" placeholder="Start writing…">'+esc(note.body)+'</textarea>'+
        '<div class="body-rendered" id="bodyRendered"></div>'+
      '</div>'+
    '</div>';

  // wire events
  document.getElementById("backBtn").addEventListener("click",function(){
    document.getElementById("app").classList.remove("show-editor");
  });

  document.getElementById("stickyBtn").addEventListener("click",function(){
    note.sticky=!note.sticky;
    note.updatedAt=Date.now();
    scheduleSave(note); renderList(); renderEditor();
  });

  document.getElementById("spoilerBtn").addEventListener("click",function(){
    note.spoiler=!note.spoiler;
    note.updatedAt=Date.now();
    scheduleSave(note); renderList(); renderEditor();
  });

  document.getElementById("restorePrevBtn").addEventListener("click",function(){
    openConfirm("Restore the version of \""+(note.title||"Untitled")+"\" saved right before this one? Your current content will be kept as the version you can restore back to.",{type:"restoreNote",id:note.id});
  });

  var titleInput=document.getElementById("titleInput");
  titleInput.addEventListener("input",function(){
    note.title=titleInput.value; note.updatedAt=Date.now();
    scheduleSave(note); renderList();
  });

  var ta=document.getElementById("bodyTextarea");
  var renderedDiv=document.getElementById("bodyRendered");
  var renderTimer=null;

  var DISCORD_CDN = /cdn\.discordapp\.com|media\.discordapp\.com/i;

  function renderMd(body) {
    if(!body||!body.trim()) return "";
    // Both libs are self-hosted, but if either failed to load, fall back to
    // escaped plain text rather than throwing and leaving the note blank.
    if(typeof marked==="undefined"||typeof DOMPurify==="undefined"){
      return '<pre style="white-space:pre-wrap;word-break:break-word;margin:0;">'+esc(body)+'</pre>';
    }
    var html = DOMPurify.sanitize(marked.parse(body), {
      ADD_TAGS: ["img"],
      ADD_ATTR: ["src","alt","title","width","height"]
    });
    // Post-process: swap Discord CDN images for a warning
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("img").forEach(function(img){
      var src = img.getAttribute("src")||"";
      if(DISCORD_CDN.test(src)){
        var warn = document.createElement("div");
        warn.className = "img-discord-warn";
        warn.innerHTML =
          "<span class='warn-icon'>⚠️</span>"+
          "<span>Discord image links expire after ~2 weeks and may stop working if left as a note. "+
          "Re-upload to a permanent host like Imgur.</span>"+
          "<a href='"+src.replace(/'/g,"%27")+"' target='_blank' rel='noopener noreferrer'>Open link ↗</a>";
        img.parentNode.replaceChild(warn, img);
      }
    });
    return tmp.innerHTML;
  }

  function showRendered() {
    var html=renderMd(note.body);
    if(!html) return; // keep textarea if nothing to render
    renderedDiv.innerHTML=html;
    ta.style.display="none";
    renderedDiv.classList.add("active");
  }

  function showTextarea() {
    clearTimeout(renderTimer);
    ta.style.display="";
    renderedDiv.classList.remove("active");
    // restore scroll to match where rendered was
    ta.focus();
  }

  // Start rendered if note already has content
  if(note.body && note.body.trim()) {
    var html=renderMd(note.body);
    renderedDiv.innerHTML=html;
    ta.style.display="none";
    renderedDiv.classList.add("active");
  }

  ta.addEventListener("blur",function(){
    clearTimeout(renderTimer);
    // Only render if window is still focused
    if(document.hasFocus()){
      var html=renderMd(note.body);
      if(html){
        renderedDiv.innerHTML=html;
        ta.style.display="none";
        renderedDiv.classList.add("active");
      }
    }
  });

  ta.addEventListener("input",function(){
    note.body=ta.value; note.updatedAt=Date.now();
    scheduleSave(note); renderList(); renderStatus();
    clearTimeout(renderTimer);
    // Keep textarea visible while typing, render after delay
    ta.style.display="";
    renderedDiv.classList.remove("active");
    renderTimer=setTimeout(function(){
      var html=renderMd(note.body);
      if(html){
        renderedDiv.innerHTML=html;
        ta.style.display="none";
        renderedDiv.classList.add("active");
      }
    }, 60000);
  });

  // Click rendered area → back to editing
  renderedDiv.addEventListener("click",function(){ 
    ta.style.display="";
    renderedDiv.classList.remove("active");
    ta.focus();
  });

  document.querySelectorAll("[data-remove-tag]").forEach(function(btn){
    btn.addEventListener("click",function(){
      note.tags=note.tags.filter(function(x){return x!==btn.getAttribute("data-remove-tag");});
      scheduleSave(note); renderEditor(); renderTagRow();
    });
  });

  var tagInput=document.getElementById("tagInput");
  tagInput.addEventListener("keydown",function(e){
    if(e.key==="Enter"||e.key===","){
      e.preventDefault();
      var v=tagInput.value.trim().toLowerCase().replace(/,/g,"");
      if(v&&note.tags.indexOf(v)===-1){note.tags.push(v); scheduleSave(note); renderEditor(); renderTagRow();}
      else tagInput.value="";
    } else if(e.key==="Backspace"&&!tagInput.value&&note.tags.length){
      note.tags.pop(); scheduleSave(note); renderEditor(); renderTagRow();
    }
  });

  document.getElementById("sendDmBtn").addEventListener("click",function(){
    openSendDmConfirm(note);
  });

  document.getElementById("reminderBtn").addEventListener("click",function(){
    openReminderModal(note);
  });

  // Due date
  var dueDateInput=document.getElementById("dueDateInput");
  dueDateInput.addEventListener("change",function(){
    note.dueDate=dueDateInput.value||null;
    note.updatedAt=Date.now();
    scheduleSave(note); renderEditor();
  });
  var dueDateClear=document.getElementById("dueDateClear");
  if(dueDateClear){
    dueDateClear.addEventListener("click",function(){
      note.dueDate=null; note.updatedAt=Date.now();
      scheduleSave(note); renderEditor();
    });
  }
}

function renderStatus() {
  var el=document.getElementById("statusLine");
  var note=state.notes[state.selectedId];
  if(!el||!note) return;
  var statusText={saving:"Saving…",saved:"Saved",error:"Error saving"}[saveStatus[note.id]]||"";
  el.textContent=wc(note.body)+" words"+(statusText?" · "+statusText:"");
}

// ---------- Wire up global controls ----------
document.getElementById("charSelectorBtn").addEventListener("click",function(e){
  e.stopPropagation();
  if(charDropdownOpen) closeCharDropdown(); else openCharDropdown();
});

document.getElementById("newCharBtn").addEventListener("click",addCharacter);
document.getElementById("newCharInput").addEventListener("keydown",function(e){
  if(e.key==="Enter") addCharacter();
});

document.getElementById("themeToggle").addEventListener("click",function(){
  state.theme=state.theme==="dark"?"light":"dark";
  localStorage.setItem("ledger-theme",state.theme);
  document.documentElement.setAttribute("data-theme",state.theme);
  renderThemeIcon();
});

function openSettingsPane(name) {
  document.querySelectorAll(".settings-nav-item[data-pane]").forEach(function(btn){
    btn.classList.toggle("active", btn.getAttribute("data-pane")===name);
  });
  document.querySelectorAll(".settings-pane").forEach(function(p){
    p.classList.toggle("hidden", p.id!=="pane-"+name);
  });
  if(name==="account"){
    document.getElementById("timezoneSelect").value=(state.user&&state.user.timezone)||"UTC";
    document.getElementById("defaultCurrencySelect").value=(state.user&&state.user.defaultCurrency)||"USD";
    document.getElementById("cpCurrentPassword").value="";
    document.getElementById("cpNewPassword").value="";
    document.getElementById("cpConfirmPassword").value="";
    billCategoriesDraft=getBillCategories().slice();
    renderBillCategoryChips();
    document.getElementById("billCategoryInput").value="";
  } else if(name==="notifications"){
    document.getElementById("discordDigestFrequency").value=(state.user&&state.user.digestFrequency)||"off";
  } else if(name==="data"){
    api("/api/me/ical-token").then(function(res){
      document.getElementById("calendarFeedUrl").value=res.url;
    });
    loadTrashList();
  } else if(name==="access"){
    document.getElementById("accessIdInput").value="";
    document.getElementById("accessLabelInput").value="";
    document.getElementById("localAccountUsername").value="";
    document.getElementById("localAccountPassword").value="";
    loadAccessList();
    loadLocalAccountsList();
  }
}

document.getElementById("settingsToggle").addEventListener("click",function(e){
  e.stopPropagation();
  openSettingsPane("account");
  document.getElementById("settingsOverlay").classList.remove("hidden");
});
document.getElementById("settingsCloseBtn").addEventListener("click",function(){
  document.getElementById("settingsOverlay").classList.add("hidden");
});
document.getElementById("settingsOverlay").addEventListener("click",function(e){
  if(e.target===this) document.getElementById("settingsOverlay").classList.add("hidden");
});
document.querySelectorAll(".settings-nav-item[data-pane]").forEach(function(btn){
  btn.addEventListener("click",function(){
    openSettingsPane(btn.getAttribute("data-pane"));
  });
});

function renderBillCategoryChips() {
  var container = document.getElementById("billCategoryChips");
  container.innerHTML = billCategoriesDraft.map(function(c){
    return '<span class="tag-chip-edit">'+esc(c)+
      '<button data-remove-category="'+esc(c)+'" aria-label="Remove" title="Remove">×</button></span>';
  }).join("");
  container.querySelectorAll("[data-remove-category]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var val=btn.getAttribute("data-remove-category");
      if(billCategoriesDraft.length<=1) return;
      billCategoriesDraft=billCategoriesDraft.filter(function(c){return c!==val;});
      renderBillCategoryChips();
    });
  });
}

document.getElementById("billCategoryInput").addEventListener("keydown",function(e){
  var input=e.target;
  if(e.key==="Enter"||e.key===","){
    e.preventDefault();
    var v=input.value.trim().replace(/,/g,"");
    if(v && v.length<=30 && billCategoriesDraft.map(function(c){return c.toLowerCase();}).indexOf(v.toLowerCase())===-1){
      billCategoriesDraft.push(v);
      renderBillCategoryChips();
    }
    input.value="";
  } else if(e.key==="Backspace"&&!input.value&&billCategoriesDraft.length>1){
    billCategoriesDraft.pop();
    renderBillCategoryChips();
  }
});

document.getElementById("billCategoriesSave").addEventListener("click",function(){
  api("/api/me/bill-categories",{method:"PUT",body:JSON.stringify({categories:billCategoriesDraft})}).then(function(res){
    if(state.user) state.user.billCategories=res.billCategories;
    billCategoriesDraft=res.billCategories.slice();
    renderBillCategoryChips();
    if(state.view==="bills") renderBillList({keepEditor:true});
    showToast("Bill categories saved");
  }).catch(function(){
    showToast("Couldn't save categories");
  });
});

document.getElementById("clearNotesBtn").addEventListener("click",function(){
  document.getElementById("settingsOverlay").classList.add("hidden");
  var c=currentChar();
  var label=c?"character \""+c.name+"\"":"all characters";
  openConfirm("Clear all notes for "+label+"? You can restore them from Settings for 30 days.",{type:"clearNotes"});
});

document.getElementById("timezoneSave").addEventListener("click",function(){
  var tz=document.getElementById("timezoneSelect").value;
  api("/api/me/timezone",{method:"PUT",body:JSON.stringify({timezone:tz})}).then(function(){
    if(state.user) state.user.timezone=tz;
    showToast("Timezone saved");
  });
});

document.getElementById("defaultCurrencySave").addEventListener("click",function(){
  var currency=document.getElementById("defaultCurrencySelect").value;
  var current=(state.user&&state.user.defaultCurrency)||"USD";
  if(currency===current){
    api("/api/me/default-currency",{method:"PUT",body:JSON.stringify({currency:currency})}).then(function(){
      if(state.user) state.user.defaultCurrency=currency;
      showToast("Default currency saved");
    });
    return;
  }
  openConfirm("Change your default currency to "+currency+"? This will also relabel all of your existing bills to "+currency+". Amounts won't be converted, just the currency shown.", {type:"changeDefaultCurrency", currency:currency});
});

document.getElementById("cpSave").addEventListener("click",function(){
  var current=document.getElementById("cpCurrentPassword").value;
  var next=document.getElementById("cpNewPassword").value;
  var confirm=document.getElementById("cpConfirmPassword").value;
  if(next.length<8){ showToast("New password must be at least 8 characters"); return; }
  if(next!==confirm){ showToast("New passwords don't match"); return; }
  api("/api/me/password",{method:"PUT",body:JSON.stringify({currentPassword:current,newPassword:next})}).then(function(){
    document.getElementById("cpCurrentPassword").value="";
    document.getElementById("cpNewPassword").value="";
    document.getElementById("cpConfirmPassword").value="";
    showToast("Password changed");
  });
});

document.getElementById("calendarFeedCopy").addEventListener("click",function(){
  var input=document.getElementById("calendarFeedUrl");
  input.select();
  input.setSelectionRange(0,99999);
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(input.value).then(function(){showToast("Link copied");}).catch(function(){
      document.execCommand("copy"); showToast("Link copied");
    });
  } else {
    document.execCommand("copy"); showToast("Link copied");
  }
});
document.getElementById("calendarFeedRegenerate").addEventListener("click",function(){
  openConfirm("Regenerate your calendar feed link? Any calendar app already subscribed to the old link will stop updating.",{type:"regenerateIcalToken"});
});

document.getElementById("discordDigestSave").addEventListener("click",function(){
  var freq=document.getElementById("discordDigestFrequency").value;
  api("/api/me/digest",{method:"PUT",body:JSON.stringify({frequency:freq})}).then(function(){
    if(state.user) state.user.digestFrequency=freq;
    showToast("Digest preference saved");
  });
});

// ---------- "How this works" help ----------
// Plain-language explanations. Kept deliberately short: the About panel has the
// full detail, this is just enough to get the mental model.
var HELP_TOPICS = {
  bills: {
    title: "How Bills works",
    steps: [
      "<strong>Add a bill</strong> with its amount, due date and how often it repeats. Give it a category (Housing, Food, and so on) so it can be grouped later.",
      "<strong>Mark it paid</strong> when you've actually paid it. A repeating bill automatically moves itself to its next due date, so you never re-enter it.",
      "<strong>The dashboard adds it all up</strong> for you: what's overdue, what's due soon, and a real month-by-month forecast for the next year based on each bill's actual dates, not an average.",
      "<strong>Set your monthly income</strong> at the bottom and it tells you what's left after this month's bills."
    ],
    example: {
      title: "For example",
      body: "Rent is <code>$1,200</code>, monthly, due the 1st. You mark it paid on the 1st of July; it jumps to 1 August on its own. July's forecast counts it once, and the yearly total counts it twelve times."
    }
  },
  budget: {
    title: "How Budget works",
    steps: [
      "<strong>Give each category a monthly target</strong> — what you intend to spend. Click the target amount on any category to change it.",
      "<strong>Bills count on their own.</strong> Anything you've marked paid in Bills is already counted against its category, so the only thing you type here is everyday spending like groceries or petrol.",
      "<strong>Log what you spend</strong> using the row near the bottom. Amount, category, done.",
      "<strong>Whatever's left rolls into next month.</strong> Finish $60 under on Food and next month starts with $60 extra. Go over and the shortfall carries too, so the total stays honest instead of quietly resetting."
    ],
    example: {
      title: "For example",
      body: "Food is budgeted <code>$400</code>. You spend <code>$340</code>, so August starts with <code>$460</code> to play with. Spend <code>$430</code> instead and August starts at <code>$370</code>. The bar shows amber for money that came from a bill and teal for what you logged yourself."
    }
  }
};

function openHelp(topic) {
  var t = HELP_TOPICS[topic];
  if(!t) return;
  document.getElementById("helpTitle").textContent = t.title;
  document.getElementById("helpBody").innerHTML =
    t.steps.map(function(s, i){
      return '<div class="help-step">'+
        '<span class="help-step-num">'+(i+1)+'</span>'+
        '<span class="help-step-text">'+s+'</span>'+
      '</div>';
    }).join("")+
    (t.example
      ? '<div class="help-example"><div class="help-example-title">'+esc(t.example.title)+'</div>'+t.example.body+'</div>'
      : "");
  document.getElementById("helpOverlay").classList.remove("hidden");
}

function closeHelp() {
  document.getElementById("helpOverlay").classList.add("hidden");
}

document.getElementById("helpCloseBtn").addEventListener("click", closeHelp);
document.getElementById("helpDoneBtn").addEventListener("click", closeHelp);
document.getElementById("helpOverlay").addEventListener("click", function(e){
  if(e.target === this) closeHelp();
});

// Delegated so it keeps working across the re-renders both views do.
document.addEventListener("click", function(e){
  var btn = e.target.closest && e.target.closest("[data-help]");
  if(btn) openHelp(btn.getAttribute("data-help"));
});

// ---------- Budget ----------
var budgetMonth = null;   // 'YYYY-MM' currently being viewed
var budgetData = null;

function thisMonthKey() {
  var d = new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

function shiftMonthKey(key, delta) {
  var parts = key.split("-");
  var d = new Date(Number(parts[0]), Number(parts[1])-1+delta, 1);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
}

function monthLabel(key) {
  var parts = key.split("-");
  return new Date(Number(parts[0]), Number(parts[1])-1, 1)
    .toLocaleDateString(undefined,{month:"long",year:"numeric"});
}

function money(n, currency) {
  var sign = n < 0 ? "−" : "";
  return sign + (currency ? currency+" " : "") + "$" + Math.abs(Number(n)||0).toFixed(2);
}

function loadBudget(month) {
  budgetMonth = month || budgetMonth || thisMonthKey();
  return api("/api/budget/"+budgetMonth).then(function(res){
    budgetData = res;
    renderBudget();
    renderBudgetMonthList();
  });
}

function renderBudgetMonthList() {
  var list = document.getElementById("budgetMonthList");
  if(!list || !budgetData) return;
  // Show the last 12 months up to whichever is later: today or the viewed month.
  var anchor = budgetMonth > thisMonthKey() ? budgetMonth : thisMonthKey();
  var months = [];
  for(var i=0;i<12;i++) months.push(shiftMonthKey(anchor, -i));
  list.innerHTML = months.map(function(m){
    return '<button class="budget-month-item'+(m===budgetMonth?" active":"")+'" data-month="'+m+'">'+
      '<span>'+esc(monthLabel(m))+'</span>'+
      (m===thisMonthKey()?'<span class="budget-month-item-amount">now</span>':'')+
    '</button>';
  }).join("");
  list.querySelectorAll("[data-month]").forEach(function(btn){
    btn.addEventListener("click",function(){ loadBudget(btn.getAttribute("data-month")); });
  });
}

function budgetCategoryRow(c, currency) {
  var totalAvailable = c.target + c.carriedIn;
  var over = c.spent > totalAvailable;
  var denom = totalAvailable > 0 ? totalAvailable : c.spent;
  var billPct = denom > 0 ? Math.min(100, (c.spentBills/denom)*100) : 0;
  var loggedPct = denom > 0 ? Math.min(100-billPct, (c.spentLogged/denom)*100) : 0;

  var availClass = c.available > 0 ? "pos" : (c.available < 0 ? "neg" : "zero");
  var availLabel = c.available < 0 ? "over" : "left";

  var carriedHtml = "";
  if(c.carriedIn) {
    carriedHtml = ' <span class="budget-carried'+(c.carriedIn<0?" neg":"")+'">'+
      (c.carriedIn<0?"− ":"+ ")+"$"+Math.abs(c.carriedIn).toFixed(2)+" carried in</span>";
  }

  var spentDetail;
  if(c.spentBills && c.spentLogged){
    spentDetail = money(c.spent)+" spent · $"+c.spentBills.toFixed(2)+" bills, $"+c.spentLogged.toFixed(2)+" logged";
  } else if(c.spentBills){
    spentDetail = money(c.spent)+" spent · all from bills";
  } else {
    spentDetail = money(c.spent)+" spent";
  }

  return '<div class="budget-cat">'+
    '<div class="budget-cat-top">'+
      '<span class="budget-cat-name">'+esc(c.category)+'</span>'+
      '<span class="budget-cat-avail '+availClass+'">'+money(c.available)+
        '<span class="budget-cat-avail-label">'+availLabel+'</span></span>'+
    '</div>'+
    '<div class="budget-bar'+(over?" over":"")+'">'+
      (billPct>0?'<span class="budget-bar-bills" style="width:'+billPct+'%"></span>':'')+
      (loggedPct>0?'<span class="budget-bar-logged" style="width:'+loggedPct+'%"></span>':'')+
    '</div>'+
    '<div class="budget-cat-meta">'+
      '<span><button class="budget-target-btn" data-edit-target="'+esc(c.category)+'">$'+c.target.toFixed(2)+' target</button>'+carriedHtml+'</span>'+
      '<span>'+esc(spentDetail)+'</span>'+
    '</div>'+
  '</div>';
}

function renderBudget() {
  var el = document.getElementById("budgetScroll");
  if(!el || !budgetData) return;
  var d = budgetData;
  var cur = d.currency;

  var catOptions = getBillCategories().map(function(c){
    return '<option value="'+esc(c)+'">'+esc(c)+'</option>';
  }).join("");

  var overspent = d.categories.filter(function(c){ return c.available < 0; });
  var noteHtml;
  if(d.income == null){
    noteHtml = 'Set an estimated monthly income on the Bills dashboard to see what\'s unallocated.';
  } else if(overspent.length){
    noteHtml = '<span class="bad">'+overspent.length+' categor'+(overspent.length===1?"y is":"ies are")+' overspent</span>, carrying into '+esc(monthLabel(shiftMonthKey(d.month,1)))+'.';
  } else {
    noteHtml = '<span class="good">Nothing is overspent this month.</span>';
  }

  var catsHtml = d.categories.length
    ? d.categories.map(function(c){ return budgetCategoryRow(c, cur); }).join("")
    : '<div class="budget-empty">No categories budgeted yet. Set a target below to start.</div>';

  // Categories that already have bills but nothing budgeted. Shown as an
  // explicit, previewable action rather than writing targets automatically.
  var suggestHtml = "";
  if(d.suggestions && d.suggestions.length){
    suggestHtml =
      '<div class="budget-suggest">'+
        '<div class="budget-suggest-title">Start from your bills</div>'+
        '<p class="budget-suggest-body">'+d.suggestions.length+' categor'+(d.suggestions.length===1?"y has":"ies have")+
          ' bills but no target yet. These amounts are what those bills cost per month, so yearly and quarterly ones are spread out rather than landing all at once. You can change any of them afterwards.</p>'+
        '<div class="budget-suggest-list">'+
          d.suggestions.map(function(s){
            return '<div class="budget-suggest-row"><span>'+esc(s.category)+
              ' <span class="budget-suggest-count">'+s.billCount+' bill'+(s.billCount===1?"":"s")+'</span></span>'+
              '<span class="budget-suggest-amount">'+money(s.amount)+'/mo</span></div>';
          }).join("")+
        '</div>'+
        '<div class="modal-actions"><button class="btn-primary" id="budgetApplySuggest">Create these targets</button></div>'+
      '</div>';
  }

  var activity = d.expenses.map(function(e){
    return { date:e.spentOn, category:e.category, note:e.note, amount:e.amount, id:e.id, isBill:false };
  }).concat(d.billPayments.map(function(p){
    return { date:p.date, category:p.category, note:p.name, amount:p.amount, id:p.billId, isBill:true };
  })).sort(function(a,b){ return (b.date||"").localeCompare(a.date||""); });

  var activityTotal = activity.reduce(function(s,a){ return s+a.amount; },0);
  var activityHtml = activity.length ? activity.map(function(a){
    return '<div class="budget-exp">'+
      '<span class="budget-exp-date">'+esc(formatDueDate(a.date))+'</span>'+
      '<span class="budget-exp-cat">'+esc(a.category)+'</span>'+
      '<span class="budget-exp-note">'+esc(a.note||"")+(a.isBill?' <span class="budget-exp-bill">· BILL</span>':'')+'</span>'+
      '<span class="budget-exp-amount">'+money(a.amount)+'</span>'+
      (a.isBill
        ? '<button class="budget-exp-del" style="opacity:0.25;cursor:not-allowed;" title="Comes from Bills" disabled>×</button>'
        : '<button class="budget-exp-del" data-del-expense="'+a.id+'" title="Delete">×</button>')+
    '</div>';
  }).join("") : '<div class="budget-empty">Nothing recorded this month yet.</div>';

  el.innerHTML =
    '<div class="budget-inner">'+
      '<div class="budget-month-nav">'+
        '<button class="budget-nav-btn" id="budgetPrev" aria-label="Previous month">‹</button>'+
        '<div class="budget-month-label">'+esc(monthLabel(d.month))+'</div>'+
        '<button class="budget-nav-btn" id="budgetNext" aria-label="Next month">›</button>'+
        (d.month!==thisMonthKey()?'<button class="budget-today-btn" id="budgetToday">Today</button>':'')+
        '<button class="help-btn" data-help="budget" title="How this works" aria-label="How this works">?</button>'+
      '</div>'+

      '<div class="budget-stats">'+
        '<div class="budget-stat"><div class="budget-stat-value">'+(d.income!=null?money(d.income):"—")+'</div><div class="budget-stat-label">Income</div></div>'+
        '<div class="budget-stat budgeted"><div class="budget-stat-value">'+money(d.totals.target)+'</div><div class="budget-stat-label">Budgeted</div></div>'+
        '<div class="budget-stat spent"><div class="budget-stat-value">'+money(d.totals.spent)+'</div><div class="budget-stat-label">Spent</div></div>'+
        '<div class="budget-stat unallocated'+(d.unallocated!=null&&d.unallocated<0?" negative":"")+'"><div class="budget-stat-value">'+(d.unallocated!=null?money(d.unallocated):"—")+'</div><div class="budget-stat-label">Unallocated</div></div>'+
      '</div>'+
      '<div class="budget-note">'+noteHtml+'</div>'+

      suggestHtml+

      '<div class="budget-section">'+
        '<div class="budget-heading"><span>Categories</span><span class="budget-heading-plain">'+esc(monthLabel(d.month))+'</span></div>'+
        '<div class="budget-legend">'+
          '<span class="budget-legend-key"><span class="budget-legend-dot bills"></span> from bills (automatic)</span>'+
          '<span class="budget-legend-key"><span class="budget-legend-dot logged"></span> logged by you</span>'+
        '</div>'+
        catsHtml+
      '</div>'+

      '<div class="budget-section">'+
        '<div class="budget-heading">Log an expense</div>'+
        '<div class="budget-quickadd">'+
          '<input class="budget-qa-amount" id="budgetQaAmount" placeholder="0.00" inputmode="decimal" />'+
          '<select class="budget-qa-cat" id="budgetQaCat">'+catOptions+'</select>'+
          '<input class="budget-qa-date" id="budgetQaDate" type="date" value="'+esc(defaultExpenseDate(d.month))+'" />'+
          '<input class="budget-qa-note" id="budgetQaNote" placeholder="Note (optional)" />'+
          '<button class="budget-qa-add" id="budgetQaAdd">Add</button>'+
        '</div>'+
      '</div>'+

      '<div class="budget-section">'+
        '<div class="budget-heading"><span>This month</span><span class="budget-heading-plain">'+money(activityTotal)+' total</span></div>'+
        '<div class="budget-exp-wrap">'+activityHtml+'</div>'+
      '</div>'+
    '</div>';

  wireBudgetEvents();
}

// When looking at a past/future month, default new expenses into that month
// rather than silently filing them under today.
function defaultExpenseDate(month) {
  var today = new Date();
  var todayKey = thisMonthKey();
  if(month === todayKey){
    return today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
  }
  return month+"-01";
}

function wireBudgetEvents() {
  var prev = document.getElementById("budgetPrev");
  if(prev) prev.addEventListener("click",function(){ loadBudget(shiftMonthKey(budgetMonth,-1)); });
  var next = document.getElementById("budgetNext");
  if(next) next.addEventListener("click",function(){ loadBudget(shiftMonthKey(budgetMonth,1)); });
  var today = document.getElementById("budgetToday");
  if(today) today.addEventListener("click",function(){ loadBudget(thisMonthKey()); });

  document.querySelectorAll("[data-edit-target]").forEach(function(btn){
    btn.addEventListener("click",function(){ beginTargetEdit(btn); });
  });

  document.querySelectorAll("[data-del-expense]").forEach(function(btn){
    btn.addEventListener("click",function(){
      api("/api/budget/expenses/"+btn.getAttribute("data-del-expense"),{method:"DELETE"}).then(function(){
        loadBudget();
        showToast("Expense removed");
      });
    });
  });

  var applyBtn = document.getElementById("budgetApplySuggest");
  if(applyBtn) applyBtn.addEventListener("click",function(){
    applyBtn.disabled = true;
    api("/api/budget/"+budgetMonth+"/apply-suggestions",{method:"POST"}).then(function(res){
      return loadBudget().then(function(){
        showToast("Created "+res.created+" target"+(res.created===1?"":"s"));
      });
    }).catch(function(){
      applyBtn.disabled = false;
      showToast("Couldn't create those targets");
    });
  });

  var addBtn = document.getElementById("budgetQaAdd");
  if(addBtn) addBtn.addEventListener("click", submitExpense);
  var amountInput = document.getElementById("budgetQaAmount");
  if(amountInput) amountInput.addEventListener("keydown",function(e){ if(e.key==="Enter") submitExpense(); });
  var noteInput = document.getElementById("budgetQaNote");
  if(noteInput) noteInput.addEventListener("keydown",function(e){ if(e.key==="Enter") submitExpense(); });
}

function beginTargetEdit(btn) {
  var category = btn.getAttribute("data-edit-target");
  var current = budgetData.categories.find(function(c){ return c.category===category; });
  var input = document.createElement("input");
  input.className = "budget-target-input";
  input.value = current ? current.target.toFixed(2) : "0.00";
  input.setAttribute("inputmode","decimal");
  btn.replaceWith(input);
  input.focus();
  input.select();

  var done = false;
  function commit(save) {
    if(done) return;
    done = true;
    if(!save){ renderBudget(); return; }
    var amount = parseFloat(input.value);
    if(!isFinite(amount) || amount < 0){ showToast("Enter a positive amount"); renderBudget(); return; }
    api("/api/budget/target",{method:"PUT",body:JSON.stringify({month:budgetMonth, category:category, amount:amount})})
      .then(function(){ loadBudget(); })
      .catch(function(){ showToast("Couldn't save that target"); renderBudget(); });
  }
  input.addEventListener("keydown",function(e){
    if(e.key==="Enter") commit(true);
    else if(e.key==="Escape") commit(false);
  });
  input.addEventListener("blur",function(){ commit(true); });
}

function submitExpense() {
  var amountEl = document.getElementById("budgetQaAmount");
  var amount = parseFloat(amountEl.value);
  if(!isFinite(amount) || amount <= 0){ showToast("Enter an amount"); amountEl.focus(); return; }
  api("/api/budget/expenses",{method:"POST",body:JSON.stringify({
    amount: amount,
    category: document.getElementById("budgetQaCat").value,
    spentOn: document.getElementById("budgetQaDate").value,
    note: document.getElementById("budgetQaNote").value,
    currency: budgetData ? budgetData.currency : "USD"
  })}).then(function(){
    return loadBudget();
  }).then(function(){
    // Keep the entry row hot so several in a row stay quick.
    var next = document.getElementById("budgetQaAmount");
    if(next) next.focus();
  }).catch(function(){
    showToast("Couldn't save that expense");
  });
}

// ---------- Import ----------
var pendingImport = null; // {data, duplicates}

function resetImportUi() {
  pendingImport = null;
  document.getElementById("importReview").classList.add("hidden");
  document.getElementById("importDupHeader").classList.add("hidden");
  document.getElementById("importDupList").innerHTML = "";
  document.getElementById("importFileInput").value = "";
}

function renderImportReview() {
  var counts = pendingImport.counts || {};
  var dups = pendingImport.duplicates || [];
  var parts = [];
  if(counts.notes) parts.push(counts.notes+" note"+(counts.notes===1?"":"s"));
  if(counts.characters) parts.push(counts.characters+" character"+(counts.characters===1?"":"s"));
  if(counts.bills) parts.push(counts.bills+" bill"+(counts.bills===1?"":"s"));

  var summary = parts.length ? "Found "+parts.join(", ")+" in this file." : "This file doesn't contain anything importable.";
  if(dups.length) summary += " "+dups.length+" of them look like things you already have, ticked below to be skipped.";
  document.getElementById("importSummary").textContent = summary;

  var list = document.getElementById("importDupList");
  document.getElementById("importDupHeader").classList.toggle("hidden", !dups.length);
  list.innerHTML = dups.map(function(d){
    return '<div class="trash-item">'+
      '<div class="trash-item-info">'+
        '<div class="trash-item-label"><span class="trash-item-kind">'+d.type.toUpperCase()+'</span> '+esc(d.label)+'</div>'+
      '</div>'+
      '<label class="trash-item-actions" style="font-size:12px;color:var(--ink-mid);cursor:pointer;">'+
        '<input type="checkbox" class="import-skip" data-key="'+esc(d.key)+'" checked /> Skip'+
      '</label>'+
    '</div>';
  }).join("");

  document.getElementById("importReview").classList.remove("hidden");
}

document.getElementById("importPickBtn").addEventListener("click",function(){
  document.getElementById("importFileInput").click();
});

document.getElementById("importFileInput").addEventListener("change",function(e){
  var file = e.target.files && e.target.files[0];
  if(!file) return;
  var reader = new FileReader();
  reader.onload = function(){
    var parsed;
    try { parsed = JSON.parse(reader.result); }
    catch(err){ showToast("That file isn't valid JSON"); resetImportUi(); return; }
    api("/api/import/preview",{method:"POST",body:JSON.stringify({data:parsed})}).then(function(res){
      pendingImport = { data: parsed, counts: res.counts, duplicates: res.duplicates };
      renderImportReview();
    }).catch(function(){
      showToast("That doesn't look like a Ledger export");
      resetImportUi();
    });
  };
  reader.onerror = function(){ showToast("Couldn't read that file"); resetImportUi(); };
  reader.readAsText(file);
});

document.getElementById("importSkipAllBtn").addEventListener("click",function(){
  document.querySelectorAll(".import-skip").forEach(function(cb){ cb.checked = true; });
});
document.getElementById("importKeepAllBtn").addEventListener("click",function(){
  document.querySelectorAll(".import-skip").forEach(function(cb){ cb.checked = false; });
});
document.getElementById("importCancelBtn").addEventListener("click",resetImportUi);

document.getElementById("importConfirmBtn").addEventListener("click",function(){
  if(!pendingImport) return;
  var skip = Array.prototype.slice.call(document.querySelectorAll(".import-skip"))
    .filter(function(cb){ return cb.checked; })
    .map(function(cb){ return cb.getAttribute("data-key"); });
  api("/api/import",{method:"POST",body:JSON.stringify({data:pendingImport.data, skip:skip})}).then(function(res){
    var added = [];
    if(res.notes) added.push(res.notes+" note"+(res.notes===1?"":"s"));
    if(res.characters) added.push(res.characters+" character"+(res.characters===1?"":"s"));
    if(res.bills) added.push(res.bills+" bill"+(res.bills===1?"":"s"));
    showToast(added.length ? "Imported "+added.join(", ") : "Nothing imported");
    resetImportUi();
    // Pull the newly imported data into the current view.
    api("/api/characters").then(function(chars){
      state.characters = chars || [];
      return loadNotes();
    }).then(function(){
      render();
      if(state.canAccessBills){
        api("/api/bills").then(function(bills){ state.bills = bills||[]; if(state.view==="bills") renderBillList(); });
      }
    });
  }).catch(function(){
    showToast("Import failed");
  });
});

// ---------- Trash ("Recently deleted") ----------
function trashDeletedLabel(deletedAt, retentionDays) {
  var daysLeft = retentionDays - Math.floor((Date.now()-deletedAt)/86400000);
  if(daysLeft<=0) return "Deleted "+formatDueDate(new Date(deletedAt).toISOString().slice(0,10))+" · removing soon";
  return "Deleted "+formatDueDate(new Date(deletedAt).toISOString().slice(0,10))+" · "+daysLeft+" day"+(daysLeft===1?"":"s")+" left";
}

function loadTrashList() {
  var list=document.getElementById("trashList");
  if(!list) return;
  api("/api/trash").then(function(res){
    var items=[]
      .concat((res.notes||[]).map(function(n){
        return { type:"note", id:n.id, label:n.title||"Untitled", deletedAt:n.deletedAt };
      }))
      .concat((res.bills||[]).map(function(b){
        return { type:"bill", id:b.id, label:b.name||"Untitled bill", deletedAt:b.deletedAt };
      }))
      .sort(function(a,b){ return b.deletedAt-a.deletedAt; });

    if(!items.length){
      list.innerHTML='<div class="trash-empty">Nothing deleted recently.</div>';
      return;
    }
    list.innerHTML=items.map(function(it){
      return '<div class="trash-item">'+
        '<div class="trash-item-info">'+
          '<div class="trash-item-label"><span class="trash-item-kind">'+(it.type==="note"?"NOTE":"BILL")+'</span> '+esc(it.label)+'</div>'+
          '<div class="trash-item-meta">'+esc(trashDeletedLabel(it.deletedAt, res.retentionDays||30))+'</div>'+
        '</div>'+
        '<div class="trash-item-actions">'+
          '<button class="trash-btn" data-restore-type="'+it.type+'" data-restore-id="'+it.id+'">Restore</button>'+
          '<button class="trash-btn danger" data-purge-type="'+it.type+'" data-purge-id="'+it.id+'">Delete forever</button>'+
        '</div>'+
      '</div>';
    }).join("");

    list.querySelectorAll("[data-restore-id]").forEach(function(btn){
      btn.addEventListener("click",function(){
        var type=btn.getAttribute("data-restore-type");
        api("/api/trash/"+type+"/"+btn.getAttribute("data-restore-id")+"/restore",{method:"POST"}).then(function(){
          loadTrashList();
          // Pull the restored item back into the active view.
          if(type==="note") loadNotes().then(render);
          else if(state.canAccessBills) api("/api/bills").then(function(bills){ state.bills=bills||[]; renderBillList(); });
          showToast("Restored");
        });
      });
    });
    list.querySelectorAll("[data-purge-id]").forEach(function(btn){
      btn.addEventListener("click",function(){
        openConfirm("Permanently delete this item? This one really can't be undone.",
          {type:"purgeTrashItem", trashType:btn.getAttribute("data-purge-type"), id:btn.getAttribute("data-purge-id")});
      });
    });
  });
}

document.getElementById("trashEmptyBtn").addEventListener("click",function(){
  openConfirm("Permanently delete everything in the trash? This can't be undone.",{type:"emptyTrash"});
});

document.getElementById("exportDataBtn").addEventListener("click",function(){
  var a=document.createElement("a");
  a.href="/api/me/export";
  a.download="ledger-export.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

document.getElementById("removeMyDataBtn").addEventListener("click",function(){
  document.getElementById("settingsOverlay").classList.add("hidden");
  openConfirm("Permanently delete ALL your data: every note, character, reminder, and bill? This can't be undone, and you'll be logged out afterward.",{type:"removeMyData"});
});

function removeMyData() {
  api("/api/me/delete-data",{method:"POST"}).then(function(){
    window.location.reload();
  });
}

// ---------- Manage access (admin only) ----------
function accessItemRow(e) {
  var removable = e.source === "dynamic";
  var tag = e.source === "admin" ? '<span class="access-item-tag">Admin</span>'
    : e.source === "env" ? '<span class="access-item-tag">From env</span>' : '';
  var displayName = e.label || e.username || "";
  var labelRow = (displayName || tag) ? '<div class="access-item-label">'+(displayName?esc(displayName):'')+tag+'</div>' : '';
  var showUsernameInId = e.username && e.username !== displayName;
  var idLine = (showUsernameInId ? esc(e.username)+' · ' : '') + esc(e.id);
  var lastLogin = e.lastLoginAt ? new Date(e.lastLoginAt).toLocaleString() : "Never logged in";
  var billsToggle =
    '<label class="access-bills-toggle" title="Let this account use its own Bills tab">'+
      '<input type="checkbox" data-bills-id="'+esc(e.id)+'"'+(e.billsAccess?' checked':'')+(e.source==="admin"?' disabled':'')+' />'+
      'Bills'+
    '</label>';
  return '<div class="access-item" data-id="'+esc(e.id)+'">'+
    '<div class="access-item-info">'+
      labelRow+
      '<div class="access-item-id">'+idLine+'</div>'+
      '<div class="access-item-id">Last login: '+esc(lastLogin)+'</div>'+
    '</div>'+
    '<div class="access-item-actions">'+
      billsToggle+
      (removable
        ? '<button class="access-remove-btn" data-remove-id="'+esc(e.id)+'" aria-label="Remove">'+
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'+
          '</button>'
        : '')+
    '</div>'+
  '</div>';
}

function renderAccessList(entries) {
  var list = document.getElementById("accessList");
  var admin = entries.find(function(e){return e.source==="admin";});
  var others = entries.filter(function(e){return e.source!=="admin";});

  var html = admin ? accessItemRow(admin) : "";
  html += others.length
    ? others.map(accessItemRow).join("")
    : '<div class="access-empty">No other restrictions: anyone with Discord can log in.</div>';
  list.innerHTML = html;

  list.querySelectorAll("[data-remove-id]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var id = btn.getAttribute("data-remove-id");
      api("/api/admin/allowlist/"+id,{method:"DELETE"}).then(function(){
        loadAccessList();
        showToast("Removed");
      });
    });
  });
  list.querySelectorAll("[data-bills-id]").forEach(function(cb){
    cb.addEventListener("change",function(){
      var id = cb.getAttribute("data-bills-id");
      var grant = cb.checked;
      var req = grant
        ? api("/api/admin/bills-access",{method:"POST",body:JSON.stringify({id:id})})
        : api("/api/admin/bills-access/"+id,{method:"DELETE"});
      req.then(function(){
        showToast(grant?"Bills access granted":"Bills access removed");
      }).catch(function(){
        cb.checked = !grant;
      });
    });
  });
}

function loadAccessList() {
  api("/api/admin/allowlist").then(renderAccessList);
}

function localAccountItemRow(e) {
  var badge = e.mustChangePassword ? '<span class="access-item-badge">Pending</span>' : '';
  var billsToggle =
    '<label class="access-bills-toggle" title="Let this account use its own Bills tab">'+
      '<input type="checkbox" data-local-bills-id="'+esc(e.id)+'"'+(e.billsAccess?' checked':'')+' />'+
      'Bills'+
    '</label>';
  var lastLogin = e.lastLoginAt ? new Date(e.lastLoginAt).toLocaleString() : "Never logged in";
  return '<div class="access-item" data-id="'+esc(e.id)+'">'+
    '<div class="access-item-info">'+
      '<div class="access-item-label">'+esc(e.username)+badge+'</div>'+
      '<div class="access-item-id">'+esc(e.id)+'</div>'+
      '<div class="access-item-id">Last login: '+esc(lastLogin)+'</div>'+
    '</div>'+
    '<div class="access-item-actions">'+
      billsToggle+
      '<button class="access-reset-btn" data-reset-id="'+esc(e.id)+'">Reset password</button>'+
      '<button class="access-remove-btn" data-remove-local-id="'+esc(e.id)+'" aria-label="Remove">'+
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'+
      '</button>'+
    '</div>'+
  '</div>';
}

function renderLocalAccountsList(entries) {
  var list = document.getElementById("localAccountsList");
  list.innerHTML = entries.length
    ? entries.map(localAccountItemRow).join("")
    : '<div class="access-empty">No local accounts yet.</div>';

  list.querySelectorAll("[data-remove-local-id]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var id = btn.getAttribute("data-remove-local-id");
      openConfirm("Remove this local account? This also permanently deletes all their notes, characters, reminders, and bills. This can't be undone.",{type:"removeLocalAccount",id:id});
    });
  });
  list.querySelectorAll("[data-reset-id]").forEach(function(btn){
    btn.addEventListener("click",function(){
      pendingResetAccountId = btn.getAttribute("data-reset-id");
      document.getElementById("rpNewPassword").value="";
      document.getElementById("resetPasswordOverlay").classList.remove("hidden");
    });
  });
  list.querySelectorAll("[data-local-bills-id]").forEach(function(cb){
    cb.addEventListener("change",function(){
      var id = cb.getAttribute("data-local-bills-id");
      var grant = cb.checked;
      var req = grant
        ? api("/api/admin/bills-access",{method:"POST",body:JSON.stringify({id:id})})
        : api("/api/admin/bills-access/"+id,{method:"DELETE"});
      req.then(function(){
        showToast(grant?"Bills access granted":"Bills access removed");
      }).catch(function(){
        cb.checked = !grant;
      });
    });
  });
}

function loadLocalAccountsList() {
  api("/api/admin/local-accounts").then(renderLocalAccountsList);
}

document.getElementById("accessAddBtn").addEventListener("click",function(){
  var idInput = document.getElementById("accessIdInput");
  var labelInput = document.getElementById("accessLabelInput");
  var id = idInput.value.trim();
  if(!/^\d{15,20}$/.test(id)){
    showToast("Enter a valid Discord user ID");
    return;
  }
  api("/api/admin/allowlist",{method:"POST",body:JSON.stringify({id:id,label:labelInput.value.trim()})}).then(function(){
    idInput.value=""; labelInput.value="";
    loadAccessList();
    showToast("Added");
  }).catch(function(){});
});

document.getElementById("localAccountAddBtn").addEventListener("click",function(){
  var userInput = document.getElementById("localAccountUsername");
  var passInput = document.getElementById("localAccountPassword");
  var username = userInput.value.trim();
  var password = passInput.value;
  if(!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)){
    showToast("Username must be 3-32 characters (letters, numbers, _ . -)");
    return;
  }
  if(password.length<8){
    showToast("Password must be at least 8 characters");
    return;
  }
  api("/api/admin/local-accounts",{method:"POST",body:JSON.stringify({username:username,password:password})}).then(function(){
    userInput.value=""; passInput.value="";
    loadLocalAccountsList();
    showToast("Account created. Share the password with them directly");
  }).catch(function(){});
});

document.getElementById("rpCancel").addEventListener("click",function(){
  document.getElementById("resetPasswordOverlay").classList.add("hidden");
});
document.getElementById("resetPasswordOverlay").addEventListener("click",function(e){
  if(e.target===this) document.getElementById("resetPasswordOverlay").classList.add("hidden");
});
document.getElementById("rpSave").addEventListener("click",function(){
  var newPassword = document.getElementById("rpNewPassword").value;
  if(newPassword.length<8){
    showToast("Password must be at least 8 characters");
    return;
  }
  api("/api/admin/local-accounts/"+pendingResetAccountId+"/password",{method:"PUT",body:JSON.stringify({newPassword:newPassword})}).then(function(){
    document.getElementById("resetPasswordOverlay").classList.add("hidden");
    loadLocalAccountsList();
    showToast("Password reset. Share the new password with them directly");
  }).catch(function(){});
});

document.getElementById("settingsLogoutBtn").addEventListener("click",function(){
  document.getElementById("settingsOverlay").classList.add("hidden");
  api("/auth/logout",{method:"POST"}).then(function(){
    state.notes={}; state.selectedId=null; state.user=null;
    showLogin();
  });
});

// ---------- Split "add" button ----------
// Primary action follows the current view; the caret menu offers the rest.
function primaryAddKind() {
  if((state.view==="bills"||state.view==="budget") && state.canAccessBills) return "bill";
  return "note";
}

function doAdd(kind) {
  if(kind==="bill" && state.canAccessBills) addBill();
  else createNote();
}

function closeAddMenu() {
  document.getElementById("addMenu").classList.add("hidden");
}

// Reflects the current view + access into the button label, menu and caret.
function refreshAddButton() {
  var kind = primaryAddKind();
  var primary = document.getElementById("addPrimaryBtn");
  primary.textContent = kind==="bill" ? "+ Add Bill" : "+ Add Note";
  primary.setAttribute("data-add", kind);
  // The caret and menu only earn their place when there's a second option.
  var multi = !!state.canAccessBills;
  document.getElementById("addSplit").classList.toggle("has-caret", multi);
  document.getElementById("addMenuToggle").classList.toggle("hidden", !multi);
  document.getElementById("addMenuBill").classList.toggle("hidden", !state.canAccessBills);
  if(!multi) closeAddMenu();
}

document.getElementById("addPrimaryBtn").addEventListener("click",function(){
  doAdd(this.getAttribute("data-add"));
});
document.getElementById("addMenuToggle").addEventListener("click",function(e){
  e.stopPropagation();
  document.getElementById("addMenu").classList.toggle("hidden");
});
document.querySelectorAll("#addMenu [data-add]").forEach(function(btn){
  btn.addEventListener("click",function(){
    closeAddMenu();
    doAdd(btn.getAttribute("data-add"));
  });
});
document.getElementById("searchInput").addEventListener("input",function(e){
  state.search=e.target.value; renderTagRow(); renderList();
});

// ---------- Send DM ----------
var pendingSendDmNote = null;
function openSendDmConfirm(note) {
  pendingSendDmNote=note;
  document.getElementById("sendDmText").textContent=
    "Send \""+(note.title||"Untitled")+"\" to your Discord DMs?";
  document.getElementById("sendDmOverlay").classList.remove("hidden");
}
document.getElementById("sendDmCancel").addEventListener("click",function(){
  document.getElementById("sendDmOverlay").classList.add("hidden");
  pendingSendDmNote=null;
});
document.getElementById("sendDmConfirm").addEventListener("click",function(){
  if(!pendingSendDmNote) return;
  var id=pendingSendDmNote.id;
  document.getElementById("sendDmOverlay").classList.add("hidden");
  pendingSendDmNote=null;
  showToast("Sending…");
  api("/api/notes/"+id+"/send-dm",{method:"POST"})
    .then(function(){ showToast("Sent to your Discord DMs ✓"); })
    .catch(function(){ showToast("Failed to send. Check the bot is configured, or contact Awucard."); });
});
document.getElementById("sendDmOverlay").addEventListener("click",function(e){
  if(e.target===this){ document.getElementById("sendDmOverlay").classList.add("hidden"); pendingSendDmNote=null; }
});

// ---------- Reminders ----------
var reminderNote = null;
var selectedQuickMins = null;

function formatFireAt(ts, timezone) {
  var tz=timezone||(state.user&&state.user.timezone)||"UTC";
  // No explicit locale -- let the browser's own locale decide date order
  // (MM/DD for US visitors, DD/MM for most EU ones, etc.) instead of
  // forcing one region's convention on everyone.
  return new Date(ts).toLocaleString(undefined,{timeZone:tz,dateStyle:"medium",timeStyle:"short"});
}

function openReminderModal(note) {
  reminderNote=note;
  selectedQuickMins=null;
  document.getElementById("reminderNoteTitle").textContent=note.title||"Untitled";
  document.getElementById("reminderRepeat").checked=false;
  document.getElementById("reminderDatetime").value="";
  document.querySelectorAll(".reminder-quick-btn").forEach(function(b){b.classList.remove("selected");});
  // Load existing reminders for this note
  api("/api/notes/"+note.id+"/reminders").then(function(reminders){
    renderReminderActiveList(reminders);
  });
  document.getElementById("reminderOverlay").classList.remove("hidden");
}

function renderReminderActiveList(reminders) {
  var container=document.getElementById("reminderActiveList");
  if(!reminders||!reminders.length){ container.innerHTML=""; return; }
  var tz=(state.user&&state.user.timezone)||"UTC";
  var html='<div class="reminder-active-title">Active reminders</div>';
  html+=reminders.map(function(r){
    var label=formatFireAt(r.fireAt,tz)+(r.repeat?" (repeating)":"");
    return '<div class="reminder-item">'+
      '<span class="reminder-item-time">'+label+'</span>'+
      '<button class="reminder-item-del" data-rid="'+r.id+'">×</button>'+
      '</div>';
  }).join("");
  container.innerHTML=html;
  container.querySelectorAll("[data-rid]").forEach(function(btn){
    btn.addEventListener("click",function(){
      api("/api/reminders/"+btn.getAttribute("data-rid"),{method:"DELETE"}).then(function(){
        return api("/api/notes/"+reminderNote.id+"/reminders");
      }).then(function(reminders){ renderReminderActiveList(reminders); });
    });
  });
}

document.querySelectorAll(".reminder-quick-btn").forEach(function(btn){
  btn.addEventListener("click",function(){
    document.querySelectorAll(".reminder-quick-btn").forEach(function(b){b.classList.remove("selected");});
    btn.classList.add("selected");
    selectedQuickMins=parseInt(btn.getAttribute("data-mins"),10);
    document.getElementById("reminderDatetime").value="";
  });
});

document.getElementById("reminderDatetime").addEventListener("input",function(){
  document.querySelectorAll(".reminder-quick-btn").forEach(function(b){b.classList.remove("selected");});
  selectedQuickMins=null;
});

document.getElementById("reminderCancel").addEventListener("click",function(){
  document.getElementById("reminderOverlay").classList.add("hidden");
  reminderNote=null;
});
document.getElementById("reminderOverlay").addEventListener("click",function(e){
  if(e.target===this){ document.getElementById("reminderOverlay").classList.add("hidden"); reminderNote=null; }
});

document.getElementById("reminderSave").addEventListener("click",function(){
  if(!reminderNote) return;
  var repeat=document.getElementById("reminderRepeat").checked;
  var fireAt, repeatInterval=null;

  if(selectedQuickMins){
    fireAt=Date.now()+(selectedQuickMins*60*1000);
    if(repeat) repeatInterval=selectedQuickMins*60*1000;
  } else {
    var dtVal=document.getElementById("reminderDatetime").value;
    if(!dtVal){ showToast("Pick a time first"); return; }
    var tz=(state.user&&state.user.timezone)||"UTC";
    // Parse the local datetime string in the user's timezone
    fireAt=new Date(dtVal).getTime();
    if(isNaN(fireAt)||fireAt<=Date.now()){ showToast("Pick a future time"); return; }
  }

  api("/api/reminders",{method:"POST",body:JSON.stringify({
    noteId:reminderNote.id,
    noteTitle:reminderNote.title||"Untitled",
    fireAt:fireAt,
    repeat:repeat,
    repeatInterval:repeatInterval
  })}).then(function(){
    document.getElementById("reminderOverlay").classList.add("hidden");
    reminderNote=null;
    showToast("Reminder set ✓");
  }).catch(function(){
    showToast("Failed. Is the bot configured?");
  });
});

// confirm modal
document.getElementById("confirmCancel").addEventListener("click",closeConfirm);
document.getElementById("confirmOk").addEventListener("click",function(){
  if(!pendingAction){closeConfirm();return;}
  if(pendingAction.type==="deleteNote") deleteNote(pendingAction.id);
  else if(pendingAction.type==="clearNotes") clearNotes();
  else if(pendingAction.type==="deleteChar") deleteCharacter(pendingAction.id);
  else if(pendingAction.type==="restoreNote") restoreNoteVersion(pendingAction.id);
  else if(pendingAction.type==="removeMyData"){
    closeConfirm();
    removeMyData();
    return;
  }
  else if(pendingAction.type==="deleteBill"){
    var billId=pendingAction.id;
    closeConfirm();
    api("/api/bills/"+billId,{method:"DELETE"}).then(function(){
      state.bills=state.bills.filter(function(b){return b.id!==billId;});
      if(state.selectedBillId===billId) state.selectedBillId=null;
      renderBillList();
      showToast("Bill deleted");
    });
    return;
  }
  else if(pendingAction.type==="removeLocalAccount"){
    var localId=pendingAction.id;
    closeConfirm();
    api("/api/admin/local-accounts/"+localId,{method:"DELETE"}).then(function(){
      loadLocalAccountsList();
      showToast("Account removed");
    });
    return;
  }
  else if(pendingAction.type==="regenerateIcalToken"){
    closeConfirm();
    api("/api/me/ical-token/regenerate",{method:"POST"}).then(function(res){
      document.getElementById("calendarFeedUrl").value=res.url;
      showToast("Calendar link regenerated");
    });
    return;
  }
  else if(pendingAction.type==="purgeTrashItem"){
    var purgeType=pendingAction.trashType, purgeId=pendingAction.id;
    closeConfirm();
    api("/api/trash/"+purgeType+"/"+purgeId,{method:"DELETE"}).then(function(){
      loadTrashList();
      showToast("Deleted forever");
    });
    return;
  }
  else if(pendingAction.type==="emptyTrash"){
    closeConfirm();
    api("/api/trash",{method:"DELETE"}).then(function(){
      loadTrashList();
      showToast("Trash emptied");
    });
    return;
  }
  else if(pendingAction.type==="changeDefaultCurrency"){
    var newCurrency=pendingAction.currency;
    closeConfirm();
    api("/api/me/default-currency",{method:"PUT",body:JSON.stringify({currency:newCurrency,applyToBills:true})}).then(function(res){
      if(state.user) state.user.defaultCurrency=newCurrency;
      state.bills.forEach(function(b){ b.currency=newCurrency; });
      if(state.view==="bills") renderBillList();
      showToast("Default currency updated"+(res&&res.billsUpdated?", "+res.billsUpdated+" bill"+(res.billsUpdated===1?"":"s")+" relabeled":""));
    });
    return;
  }
  closeConfirm();
});
document.getElementById("confirmOverlay").addEventListener("click",function(e){
  if(e.target===this) closeConfirm();
});

// char edit modal
document.getElementById("charEditCancel").addEventListener("click",function(){
  document.getElementById("charEditOverlay").classList.add("hidden");
  editingCharId=null;
});
document.getElementById("charEditSave").addEventListener("click",saveCharEdit);
document.getElementById("charEditOverlay").addEventListener("click",function(e){
  if(e.target===this){document.getElementById("charEditOverlay").classList.add("hidden"); editingCharId=null;}
});

// close dropdowns/menus on outside click
document.addEventListener("click",function(e){
  var dropdown=document.getElementById("charDropdown");
  var btn=document.getElementById("charSelectorBtn");
  if(charDropdownOpen&&!dropdown.contains(e.target)&&!btn.contains(e.target)){
    closeCharDropdown();
  }
  var addSplit=document.getElementById("addSplit");
  if(addSplit&&!addSplit.contains(e.target)) closeAddMenu();
});

// global keyboard shortcuts
document.addEventListener("keydown",function(e){
  // Escape — close any open overlay or dropdown
  if(e.key==="Escape"){
    closeCharDropdown();
    closeAddMenu();
    document.getElementById("settingsOverlay").classList.add("hidden");
    document.getElementById("confirmOverlay").classList.add("hidden");
    document.getElementById("charEditOverlay").classList.add("hidden");
    document.getElementById("infoOverlay").classList.add("hidden");
    document.getElementById("helpOverlay").classList.add("hidden");
    return;
  }
  // Ctrl/Cmd+S — force save current note immediately
  if((e.ctrlKey||e.metaKey)&&e.key==="s"){
    e.preventDefault();
    var note=state.notes[state.selectedId];
    if(note){
      clearTimeout(saveTimers[note.id]);
      api("/api/notes/"+note.id,{method:"PUT",body:JSON.stringify({title:note.title,body:note.body,tags:note.tags,sticky:note.sticky,spoiler:note.spoiler,dueDate:note.dueDate||null})})
        .then(function(updated){
          saveStatus[note.id]="saved";
          note.prevTitle=updated.prevTitle; note.prevBody=updated.prevBody; note.prevSavedAt=updated.prevSavedAt;
          renderStatus();
          updateRestoreBtnVisibility(note);
        })
        .catch(function(){saveStatus[note.id]="error"; renderStatus();});
    }
  }
});


document.getElementById("infoBtn").addEventListener("click",function(){
  document.getElementById("infoOverlay").classList.remove("hidden");
});
document.getElementById("infoClose").addEventListener("click",function(){
  document.getElementById("infoOverlay").classList.add("hidden");
});
document.getElementById("infoOverlay").addEventListener("click",function(e){
  if(e.target===this) document.getElementById("infoOverlay").classList.add("hidden");
});
document.querySelectorAll(".info-tab").forEach(function(tab){
  tab.addEventListener("click",function(){
    document.querySelectorAll(".info-tab").forEach(function(t){ t.classList.remove("active"); });
    document.querySelectorAll(".info-panel").forEach(function(p){ p.classList.add("hidden"); });
    tab.classList.add("active");
    document.getElementById("tab-"+tab.getAttribute("data-tab")).classList.remove("hidden");
  });
});

(function setupDonateCounter(){
  var donateBtn = document.getElementById("donateBtn");
  var donateCount = document.getElementById("donateCount");
  if (!donateBtn || !donateCount) return;
  var count = 1;
  donateBtn.addEventListener("click", function(){
    count += 1;
    donateCount.textContent = "Someone unforunately clicked this " + count + " times and donated! 😇";
  });
})();

// ===================== CALENDAR =====================
var DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function sameDay(a, b) {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function dayKey(d) {
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function dateFromKey(k) { return new Date(k+"T00:00:00"); }

function switchView(view) {
  state.view = view;
  refreshAddButton();
  var notesContent = document.getElementById("notesViewContent");
  var billsContent = document.getElementById("billsViewContent");
  var calSide = document.getElementById("calSidePanel");
  var editor = document.getElementById("editor");
  var calMain = document.getElementById("calMain");
  var billMain = document.getElementById("billMain");
  var budgetContent = document.getElementById("budgetViewContent");
  var budgetMain = document.getElementById("budgetMain");

  document.querySelectorAll(".view-tab").forEach(function(t){
    t.classList.toggle("active", t.getAttribute("data-view")===view);
  });

  notesContent.style.display = "none";
  billsContent.style.display = "none";
  budgetContent.style.display = "none";
  calSide.classList.add("hidden");
  editor.classList.add("hidden");
  calMain.classList.add("hidden");
  billMain.classList.add("hidden");
  budgetMain.classList.add("hidden");

  if(view === "budget") {
    document.getElementById("app").classList.remove("show-calendar");
    document.getElementById("app").classList.remove("show-bills");
    document.getElementById("app").classList.add("show-budget");
    budgetContent.style.display = "flex";
    budgetMain.classList.remove("hidden");
    loadBudget();
  } else if(view === "calendar") {
    calSide.classList.remove("hidden");
    calMain.classList.remove("hidden");
    document.getElementById("app").classList.remove("show-bills");
    document.getElementById("app").classList.remove("show-budget");
    document.getElementById("app").classList.add("show-calendar");
    var fetches = [api("/api/notes?characterId=__all__"), api("/api/reminders")];
    if(state.canAccessBills) fetches.push(api("/api/bills"));
    Promise.all(fetches).then(function(results){
      state.calAllNotes = {};
      (results[0]||[]).forEach(function(n){ state.calAllNotes[n.id]=n; });
      state.calReminders = results[1]||[];
      if(state.canAccessBills) state.bills = results[2]||[];
      renderCalendar();
      renderCalSidePanel(state.calSelected);
    });
  } else if(view === "bills") {
    document.getElementById("app").classList.remove("show-calendar");
    document.getElementById("app").classList.remove("show-budget");
    document.getElementById("app").classList.add("show-bills");
    billsContent.style.display = "flex";
    billMain.classList.remove("hidden");
    api("/api/bills").then(function(bills){
      state.bills = bills||[];
      renderBillList();
    });
  } else {
    document.getElementById("app").classList.remove("show-calendar");
    document.getElementById("app").classList.remove("show-bills");
    document.getElementById("app").classList.remove("show-budget");
    // Must be "flex", not "" -- notesViewContent's flex layout is what gives
    // the note list its bounded height + scroll. Clearing to "" falls back to
    // display:block (no stylesheet rule sets it), which lets the list grow to
    // full content height with no scrollbar after switching back from a view.
    notesContent.style.display = "flex";
    editor.classList.remove("hidden");
  }
}

// Build a map of dayKey → {notes:[], reminders:[], bills:[]}
function buildEventMap() {
  var map = {};
  function ensure(k){ if(!map[k]) map[k]={notes:[],reminders:[],bills:[]}; return map[k]; }
  Object.values(state.calAllNotes).forEach(function(n){
    if(n.dueDate) ensure(n.dueDate).notes.push(n);
  });
  state.calReminders.forEach(function(r){
    ensure(dayKey(new Date(r.fireAt))).reminders.push(r);
  });
  if(state.canAccessBills){
    (state.bills||[]).forEach(function(b){
      if(b.dueDate) ensure(b.dueDate).bills.push(b);
    });
  }
  return map;
}

function renderCalendar() {
  // update title + nav
  var a = state.calAnchor;
  var titleEl = document.getElementById("calTitle");
  if(state.calMode === "month") {
    titleEl.textContent = MONTHS[a.getMonth()] + " " + a.getFullYear();
    renderMonthGrid(buildEventMap());
  } else {
    // Week: find Monday of this week
    var monday = new Date(a);
    var day = monday.getDay()||7;
    monday.setDate(monday.getDate()-(day-1));
    var sunday = new Date(monday); sunday.setDate(sunday.getDate()+6);
    titleEl.textContent = MONTHS[monday.getMonth()]+" "+monday.getDate()+" – "+(monday.getMonth()!==sunday.getMonth()?MONTHS[sunday.getMonth()]+" ":"")+sunday.getDate()+", "+sunday.getFullYear();
    renderWeekGrid(monday, buildEventMap());
  }
  // sync mode buttons
  document.querySelectorAll(".cal-mode-btn").forEach(function(b){
    b.classList.toggle("active", b.getAttribute("data-mode")===state.calMode);
  });
}

function renderMonthGrid(eventMap) {
  var body = document.getElementById("calBody");
  var a = state.calAnchor;
  var today = new Date();

  // Start of grid: Sunday of the week containing the 1st
  var first = new Date(a.getFullYear(), a.getMonth(), 1);
  var startOffset = first.getDay(); // 0=Sun
  var gridStart = new Date(first); gridStart.setDate(1 - startOffset);

  var rows = "";
  // DOW header
  var dowRow = '<div class="cal-dow-row">';
  DOW.forEach(function(d){ dowRow += '<div class="cal-dow">'+d+'</div>'; });
  dowRow += '</div>';

  var cells = "";
  for(var i=0; i<42; i++){
    var d = new Date(gridStart); d.setDate(gridStart.getDate()+i);
    var k = dayKey(d);
    var events = eventMap[k]||{notes:[],reminders:[]};
    var isToday = sameDay(d, today);
    var isSelected = state.calSelected && sameDay(d, state.calSelected);
    var isOther = d.getMonth() !== a.getMonth();

    var cls = "cal-day";
    if(isToday) cls += " today";
    if(isSelected) cls += " selected";
    if(isOther) cls += " other-month";

    var pills = "";
    events.notes.slice(0,2).forEach(function(n){
      var char = state.characters.find(function(c){return c.id===n.characterId;});
      var color = char ? char.color : "var(--teal)";
      pills += '<div class="cal-event-pill due" style="border-left:2px solid '+color+'">'+esc(n.title||"Untitled")+'</div>';
    });
    events.reminders.slice(0,1).forEach(function(r){
      pills += '<div class="cal-event-pill reminder">🔔 '+esc(r.noteTitle||"Reminder")+'</div>';
    });
    (events.bills||[]).slice(0,1).forEach(function(b){
      var todayStr = new Date().toISOString().slice(0,10);
      var billCls = b.paid ? "bill-paid" : (b.dueDate < todayStr ? "bill-overdue" : "bill-upcoming");
      pills += '<div class="cal-event-pill '+billCls+'">💳 '+esc(b.name)+'</div>';
    });
    var total = events.notes.length + events.reminders.length + (events.bills||[]).length;
    var overflow = total > 3 ? '<div class="cal-overflow">+' + (total-3) + ' more</div>' : "";

    cells += '<div class="'+cls+'" data-key="'+k+'"><div class="cal-day-num">'+d.getDate()+'</div><div class="cal-day-events">'+pills+overflow+'</div></div>';
  }

  body.innerHTML = '<div class="cal-month">'+dowRow+'<div class="cal-grid">'+cells+'</div></div>';

  body.querySelectorAll(".cal-day").forEach(function(cell){
    cell.addEventListener("click", function(){
      state.calSelected = dateFromKey(cell.getAttribute("data-key"));
      renderCalendar();
      renderCalSidePanel(state.calSelected);
    });
  });
  body.querySelectorAll(".cal-event-pill").forEach(function(pill){
    pill.addEventListener("click", function(e){
      e.stopPropagation();
      state.calSelected = dateFromKey(pill.closest(".cal-day").getAttribute("data-key"));
      renderCalendar();
      renderCalSidePanel(state.calSelected);
    });
  });
}

function renderWeekGrid(monday, eventMap) {
  var body = document.getElementById("calBody");
  var today = new Date();

  var headerCells = "";
  var bodyCells = "";
  for(var i=0; i<7; i++){
    var d = new Date(monday); d.setDate(monday.getDate()+i);
    var k = dayKey(d);
    var events = eventMap[k]||{notes:[],reminders:[]};
    var isToday = sameDay(d, today);
    var isSelected = state.calSelected && sameDay(d, state.calSelected);

    headerCells += '<div class="cal-week-col-head'+(isToday?" today":"")+'">'+
      '<div class="cal-week-dow">'+DOW[d.getDay()]+'</div>'+
      '<div class="cal-week-date">'+d.getDate()+'</div>'+
    '</div>';

    var evHtml = "";
    events.notes.forEach(function(n){
      var char = state.characters.find(function(c){return c.id===n.characterId;});
      var color = char ? char.color : "var(--teal)";
      evHtml += '<div class="cal-week-event due" data-note-id="'+n.id+'" style="border-left:2px solid '+color+'">'+esc(n.title||"Untitled")+'</div>';
    });
    events.reminders.forEach(function(r){
      var t = new Date(r.fireAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      evHtml += '<div class="cal-week-event reminder">🔔 '+t+' '+esc(r.noteTitle||"")+'</div>';
    });

    bodyCells += '<div class="cal-week-day'+(isSelected?" selected":"")+(isToday?" today":"")+'" data-key="'+k+'">'+evHtml+'</div>';
  }

  body.innerHTML = '<div class="cal-week">'+
    '<div class="cal-week-header">'+headerCells+'</div>'+
    '<div class="cal-week-body">'+bodyCells+'</div>'+
  '</div>';

  body.querySelectorAll(".cal-week-day").forEach(function(cell){
    cell.addEventListener("click", function(){
      state.calSelected = dateFromKey(cell.getAttribute("data-key"));
      renderCalendar();
      renderCalSidePanel(state.calSelected);
    });
  });
  body.querySelectorAll(".cal-week-event.due[data-note-id]").forEach(function(ev){
    ev.addEventListener("click", function(e){
      e.stopPropagation();
      var nid = ev.getAttribute("data-note-id");
      // Switch to notes view and open the note
      switchView("notes");
      state.selectedId = nid;
      render();
      document.getElementById("app").classList.add("show-editor");
    });
  });
}

function renderCalSidePanel(date) {
  var dateEl = document.getElementById("calSideDate");
  var bodyEl = document.getElementById("calSideBody");
  var addBtn = document.getElementById("calSideAddNote");

  if(!date){
    dateEl.textContent="Select a day";
    bodyEl.innerHTML='<div class="cal-side-empty">Click a day to see its notes and reminders.</div>';
    addBtn.disabled=true;
    addBtn.style.opacity="0.35";
    addBtn.style.cursor="not-allowed";
    return;
  }

  addBtn.disabled=false;
  addBtn.style.opacity="";
  addBtn.style.cursor="";

  var k = dayKey(date);
  var eventMap = buildEventMap();
  var events = eventMap[k]||{notes:[],reminders:[],bills:[]};
  var tz = (state.user&&state.user.timezone)||"UTC";
  var todayStr = new Date().toISOString().slice(0,10);

  dateEl.textContent = date.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"});

  var html = "";
  if(events.notes.length){
    html += '<div class="cal-side-section"><div class="cal-side-heading">Due notes</div>';
    events.notes.forEach(function(n){
      var char = state.characters.find(function(c){return c.id===n.characterId;});
      var color = char ? char.color : "var(--teal)";
      html += '<div class="cal-side-item" data-note-id="'+n.id+'" style="border-left-color:'+color+'">'+
        '<div class="cal-side-item-title">'+esc(n.title||"Untitled")+'</div>'+
        '<div class="cal-side-item-meta">'+(char?esc(char.name):"No character")+(n.tags&&n.tags.length?" · #"+n.tags.slice(0,2).join(" #"):"")+'</div>'+
      '</div>';
    });
    html += '</div>';
  }
  if((events.bills||[]).length){
    html += '<div class="cal-side-section"><div class="cal-side-heading">Bills due</div>';
    events.bills.forEach(function(b){
      var isOverdue = !b.paid && b.dueDate < todayStr;
      var statusCls = b.paid?"bill-status-paid":(isOverdue?"bill-status-overdue":"bill-status-upcoming");
      var statusLbl = b.paid?"✅ Paid":(isOverdue?"⚠ Overdue":"Due");
      html += '<div class="cal-side-item" data-bill-id="'+b.id+'" style="border-left-color:'+b.color+'">'+
        '<div class="cal-side-item-title">💳 '+esc(b.name)+'</div>'+
        '<div class="cal-side-item-meta"><span class="'+statusCls+'">'+statusLbl+'</span> · '+b.currency+' $'+Number(b.amount).toFixed(2)+'</div>'+
      '</div>';
    });
    html += '</div>';
  }
  if(events.reminders.length){
    html += '<div class="cal-side-section"><div class="cal-side-heading">Reminders</div>';
    events.reminders.forEach(function(r){
      var t = new Date(r.fireAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",timeZone:tz});
      html += '<div class="cal-side-item reminder-item">'+
        '<div class="cal-side-item-title">🔔 '+esc(r.noteTitle||"Reminder")+'</div>'+
        '<div class="cal-side-item-meta">'+t+(r.repeat?" · repeating":"")+'</div>'+
      '</div>';
    });
    html += '</div>';
  }
  if(!events.notes.length && !events.reminders.length && !(events.bills||[]).length){
    html = '<div class="cal-side-empty">Nothing scheduled for this day.</div>';
  }
  bodyEl.innerHTML = html;

  bodyEl.querySelectorAll(".cal-side-item[data-note-id]").forEach(function(item){
    item.addEventListener("click", function(){
      var nid = item.getAttribute("data-note-id");
      switchView("notes");
      state.selectedId = nid;
      render();
      document.getElementById("app").classList.add("show-editor");
    });
  });
  bodyEl.querySelectorAll(".cal-side-item[data-bill-id]").forEach(function(item){
    item.addEventListener("click", function(){
      state.selectedBillId = item.getAttribute("data-bill-id");
      switchView("bills");
    });
  });
}

// Wire up calendar controls
document.querySelectorAll(".view-tab").forEach(function(btn){
  btn.addEventListener("click", function(){
    var view = btn.getAttribute("data-view");
    if(view === "bills" && state.view === "bills" && state.selectedBillId){
      state.selectedBillId = null;
      renderBillList();
      return;
    }
    switchView(view);
  });
});

document.getElementById("calBackBtn").addEventListener("click", function(){
  document.getElementById("app").classList.remove("show-calendar");
});

document.getElementById("billMainBackBtn").addEventListener("click", function(){
  document.getElementById("app").classList.remove("show-bills");
});

document.getElementById("budgetMainBackBtn").addEventListener("click", function(){
  document.getElementById("app").classList.remove("show-budget");
});

document.getElementById("calPrev").addEventListener("click", function(){
  var a = state.calAnchor;
  if(state.calMode==="month"){
    state.calAnchor = new Date(a.getFullYear(), a.getMonth()-1, 1);
  } else {
    var d = new Date(a); d.setDate(d.getDate()-7);
    state.calAnchor = d;
  }
  renderCalendar();
});
document.getElementById("calNext").addEventListener("click", function(){
  var a = state.calAnchor;
  if(state.calMode==="month"){
    state.calAnchor = new Date(a.getFullYear(), a.getMonth()+1, 1);
  } else {
    var d = new Date(a); d.setDate(d.getDate()+7);
    state.calAnchor = d;
  }
  renderCalendar();
});
document.getElementById("calToday").addEventListener("click", function(){
  state.calAnchor = new Date();
  state.calSelected = new Date();
  renderCalendar();
  renderCalSidePanel(state.calSelected);
});
document.querySelectorAll(".cal-mode-btn").forEach(function(btn){
  btn.addEventListener("click", function(){
    state.calMode = btn.getAttribute("data-mode");
    renderCalendar();
  });
});
document.getElementById("calSideAddNote").addEventListener("click", function(){
  if(!state.calSelected) return;
  var k = dayKey(state.calSelected);
  switchView("notes");
  var charId = state.characterId==="__all__" ? null : state.characterId;
  api("/api/notes",{method:"POST",body:JSON.stringify({title:"",body:"",tags:[],characterId:charId,dueDate:k})})
    .then(function(note){
      state.notes[note.id]=note;
      state.selectedId=note.id;
      render();
      document.getElementById("app").classList.add("show-editor");
      var el=document.getElementById("titleInput");
      if(el) el.focus();
    });
});

// ===================== BILLS =====================
var BILL_PRIORITIES = ["low","medium","high","urgent"];
var PRIORITY_LABELS = { low:"Low", medium:"Medium", high:"High", urgent:"Urgent" };
var PRIORITY_COLORS = { low:"#4fa8a0", medium:"#7c8cc9", high:"#e8a33d", urgent:"#c9605a" };
var PRIORITY_ORDER = { urgent:3, high:2, medium:1, low:0 };
var DEFAULT_BILL_CATEGORIES = ["Housing","Utilities","Entertainment","Insurance","Subscriptions","Food","Transport","Health","Savings","Other"];
function getBillCategories() {
  var list = state.user && state.user.billCategories;
  return (list && list.length) ? list : DEFAULT_BILL_CATEGORIES;
}
var BILL_FREQS = [
  {val:"one-time",label:"One-time"},{val:"weekly",label:"Weekly"},
  {val:"biweekly",label:"Bi-weekly"},{val:"monthly",label:"Monthly"},
  {val:"quarterly",label:"Quarterly"},{val:"yearly",label:"Yearly"}
];
var BILL_CURRENCIES = ["CAD","USD","EUR","GBP","AUD","NZD","CHF","JPY","SEK","NOK","DKK"];

function billStatus(b) {
  var today = new Date().toISOString().slice(0,10);
  if(b.paid) return "paid";
  if(b.dueDate && b.dueDate < today) return "overdue";
  return "upcoming";
}

// Display-only formatting for a "YYYY-MM-DD" due date, following the
// browser's own locale (MM/DD for US, DD/MM for most EU locales, etc).
// The underlying dueDate string itself stays ISO everywhere else --
// sorting, comparisons, and month-slicing all depend on that -- this is
// only ever used at the point a date gets rendered as text.
function formatDueDate(dateStr) {
  if(!dateStr) return "No date";
  return new Date(dateStr+"T00:00:00").toLocaleDateString(undefined,{year:"numeric",month:"2-digit",day:"2-digit"});
}

function renderBillList(opts) {
  opts = opts || {};
  var list = document.getElementById("billList");
  var placeholder = document.getElementById("billPlaceholder");
  var editor = document.getElementById("billEditor");
  var today = new Date().toISOString().slice(0,10);

  if(!state.bills.length){
    list.innerHTML = '<div class="bill-sidebar-empty">No bills yet.<br>Add one below.</div>';
  } else {
    list.innerHTML = state.bills.map(function(b){
      var status = billStatus(b);
      var cardCls = "bill-card"+(b.id===state.selectedBillId?" active":"")+(status==="overdue"?" overdue":status==="paid"?" paid":"");
      var dueCls = status==="overdue"?" overdue":"";
      var payBtnCls = status==="paid"?" paid":"";
      var payBtnLbl = status==="paid"?"✓ Paid":"Pay";
      var freqBadge = b.frequency!=="one-time"?'<span class="bill-badge freq">'+b.frequency+'</span>':"";
      var autoBadge = b.autoPay?'<span class="bill-badge autopay">auto</span>':"";
      return '<div class="'+cardCls+'" data-bill-id="'+b.id+'" style="border-left-color:'+b.color+'">'+
        '<div class="bill-card-header">'+
          '<span class="bill-card-name">'+esc(b.name)+'</span>'+
          '<span class="bill-card-amount">'+b.currency+' $'+Number(b.amount).toFixed(2)+'</span>'+
        '</div>'+
        '<div class="bill-card-meta">'+
          '<span class="bill-card-due'+dueCls+'">'+formatDueDate(b.dueDate)+'</span>'+
          '<div class="bill-card-badges">'+freqBadge+autoBadge+
            '<button class="bill-pay-btn'+payBtnCls+'" data-pay-id="'+b.id+'">'+payBtnLbl+'</button>'+
          '</div>'+
        '</div>'+
      '</div>';
    }).join("");

    list.querySelectorAll(".bill-card").forEach(function(card){
      card.addEventListener("click",function(e){
        if(e.target.closest("[data-pay-id]")) return;
        state.selectedBillId = card.getAttribute("data-bill-id");
        document.getElementById("app").classList.add("show-bills");
        renderBillList();
        renderBillEditor();
      });
    });
    list.querySelectorAll("[data-pay-id]").forEach(function(btn){
      btn.addEventListener("click",function(e){
        e.stopPropagation();
        var id = btn.getAttribute("data-pay-id");
        var bill = state.bills.find(function(b){return b.id===id;});
        if(!bill) return;
        var isPaid = billStatus(bill)==="paid";
        api("/api/bills/"+id+(isPaid?"/unpay":"/pay"),{method:"POST"}).then(function(updated){
          var idx=state.bills.findIndex(function(b){return b.id===id;});
          if(idx>-1) state.bills[idx]=updated;
          if(state.selectedBillId===id) renderBillEditor();
          renderBillList();
          showToast(isPaid?"Marked unpaid":"Marked paid ✓");
        });
      });
    });
  }

  if(state.selectedBillId && state.bills.find(function(b){return b.id===state.selectedBillId;})){
    placeholder.classList.add("hidden");
    editor.classList.remove("hidden");
    if(!opts.keepEditor) renderBillEditor();
  } else {
    placeholder.classList.remove("hidden");
    editor.classList.add("hidden");
    renderBillDashboard();
  }
}

var FORECAST_MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Mirrors store.js's addMonthsClamped/advanceDueDate exactly, so a bill's
// projected future occurrences land on the same dates the server would give it.
function addMonthsClampedClient(d, months) {
  var day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  var daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInMonth));
  return d;
}

function advanceDueDateClient(dateStr, frequency) {
  var d = new Date(dateStr + "T00:00:00");
  switch(frequency){
    case "weekly":    d.setDate(d.getDate() + 7); break;
    case "biweekly":  d.setDate(d.getDate() + 14); break;
    case "monthly":   addMonthsClampedClient(d, 1); break;
    case "quarterly": addMonthsClampedClient(d, 3); break;
    case "yearly":    d.setFullYear(d.getFullYear() + 1); break;
    default: return null; // one-time bills don't recur
  }
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

// Projects each bill's actual future due dates forward (not an averaged rate),
// bucketing amounts into the calendar month they'll really land in.
function buildBillForecast(bills, monthsAhead) {
  var today = new Date(); today.setHours(0,0,0,0);
  var monthKeys = [];
  for(var i=0;i<monthsAhead;i++){
    var d = new Date(today.getFullYear(), today.getMonth()+i, 1);
    monthKeys.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));
  }
  var totals = {};
  monthKeys.forEach(function(mk){ totals[mk] = {}; });
  var horizonEnd = monthKeys[monthKeys.length-1];

  bills.forEach(function(b){
    if(!b.dueDate) return;
    if(b.frequency === "one-time"){
      if(b.paid) return;
      var mk0 = b.dueDate.slice(0,7);
      if(totals[mk0]) totals[mk0][b.currency] = (totals[mk0][b.currency]||0) + Number(b.amount||0);
      return;
    }
    var cursor = b.dueDate;
    var guard = 0;
    while(cursor && cursor.slice(0,7) <= horizonEnd && guard < 80){
      guard++;
      var mk = cursor.slice(0,7);
      if(totals[mk]) totals[mk][b.currency] = (totals[mk][b.currency]||0) + Number(b.amount||0);
      cursor = advanceDueDateClient(cursor, b.frequency);
    }
  });

  return monthKeys.map(function(mk){ return { month: mk, totals: totals[mk] }; });
}

// Same walk as buildBillForecast, but keeps a per-bill occurrence count
// instead of collapsing into a currency total -- powers the "how is this
// calculated" breakdown so it can never drift out of sync with the totals.
function buildBillBreakdown(bills, monthsAhead) {
  var today = new Date(); today.setHours(0,0,0,0);
  var monthKeys = [];
  for(var i=0;i<monthsAhead;i++){
    var d = new Date(today.getFullYear(), today.getMonth()+i, 1);
    monthKeys.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));
  }
  var thisMonthKey = monthKeys[0];
  var horizonEnd = monthKeys[monthKeys.length-1];

  var thisMonthRows = [], yearRows = [];

  bills.forEach(function(b){
    if(!b.dueDate) return;
    var thisMonthCount = 0, yearCount = 0;
    if(b.frequency === "one-time"){
      if(!b.paid){
        if(b.dueDate.slice(0,7) === thisMonthKey) thisMonthCount = 1;
        if(b.dueDate.slice(0,7) <= horizonEnd) yearCount = 1;
      }
    } else {
      var cursor = b.dueDate;
      var guard = 0;
      while(cursor && cursor.slice(0,7) <= horizonEnd && guard < 80){
        guard++;
        if(cursor.slice(0,7) === thisMonthKey) thisMonthCount++;
        yearCount++;
        cursor = advanceDueDateClient(cursor, b.frequency);
      }
    }
    var amt = Number(b.amount)||0;
    if(thisMonthCount>0) thisMonthRows.push({ bill:b, count:thisMonthCount, subtotal: thisMonthCount*amt });
    if(yearCount>0) yearRows.push({ bill:b, count:yearCount, subtotal: yearCount*amt });
  });

  return { thisMonthKey: thisMonthKey, thisMonthRows: thisMonthRows, yearRows: yearRows };
}

function forecastMonthLabel(monthKey){
  var parts = monthKey.split("-");
  return FORECAST_MONTH_NAMES[Number(parts[1])-1] + " " + parts[0];
}

function forecastTotalsLine(totalsObj){
  var keys = Object.keys(totalsObj);
  if(!keys.length) return "—";
  return keys.map(function(cur){ return cur+" $"+totalsObj[cur].toFixed(2); }).join(" · ");
}

// Same forward walk as buildBillForecast, grouped by category instead of
// month -- shows where the next `monthsAhead` months of spend will go.
function buildCategoryBreakdown(bills, monthsAhead) {
  var today = new Date(); today.setHours(0,0,0,0);
  var monthKeys = [];
  for(var i=0;i<monthsAhead;i++){
    var d = new Date(today.getFullYear(), today.getMonth()+i, 1);
    monthKeys.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));
  }
  var horizonEnd = monthKeys[monthKeys.length-1];
  var totals = {};

  bills.forEach(function(b){
    if(!b.dueDate) return;
    var cat = b.category || "Other";
    if(!totals[cat]) totals[cat] = {};
    if(b.frequency === "one-time"){
      if(b.paid) return;
      if(b.dueDate.slice(0,7) <= horizonEnd) totals[cat][b.currency] = (totals[cat][b.currency]||0) + Number(b.amount||0);
      return;
    }
    var cursor = b.dueDate;
    var guard = 0;
    while(cursor && cursor.slice(0,7) <= horizonEnd && guard < 80){
      guard++;
      totals[cat][b.currency] = (totals[cat][b.currency]||0) + Number(b.amount||0);
      cursor = advanceDueDateClient(cursor, b.frequency);
    }
  });

  return Object.keys(totals).map(function(cat){ return { category: cat, totals: totals[cat] }; })
    .sort(function(a,b){
      var sumA = Object.keys(a.totals).reduce(function(s,c){return s+a.totals[c];},0);
      var sumB = Object.keys(b.totals).reduce(function(s,c){return s+b.totals[c];},0);
      return sumB - sumA;
    });
}

// Looks backward using each bill's real paidDates history -- not a
// projection, this is what was actually paid.
function buildPaymentHistory(bills, monthsBack) {
  var today = new Date(); today.setHours(0,0,0,0);
  var monthKeys = [];
  for(var i=monthsBack-1;i>=0;i--){
    var d = new Date(today.getFullYear(), today.getMonth()-i, 1);
    monthKeys.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"));
  }
  var totals = {};
  monthKeys.forEach(function(mk){ totals[mk] = {}; });

  bills.forEach(function(b){
    (b.paidDates||[]).forEach(function(pd){
      var mk = String(pd.date||"").slice(0,7);
      // Uses the amount recorded at payment time, so editing a bill's amount
      // no longer retroactively rewrites what past months cost.
      if(totals[mk]) totals[mk][b.currency] = (totals[mk][b.currency]||0) + Number(pd.amount||0);
    });
  });

  return monthKeys.map(function(mk){ return { month: mk, totals: totals[mk] }; });
}

function renderIncomeNetLine() {
  var netEl = document.getElementById("incomeNetLine");
  if(!netEl) return;
  var income = state.user && state.user.incomeEstimate;
  var currency = (state.user && state.user.incomeCurrency) || "USD";
  if(income == null || income === ""){ netEl.textContent=""; netEl.className="bill-dash-net"; return; }
  var thisMonth = buildBillForecast(state.bills, 1)[0].totals;
  var spend = thisMonth[currency] || 0;
  var net = Number(income) - spend;
  netEl.className = "bill-dash-net " + (net>=0 ? "positive" : "negative");
  netEl.textContent = (net>=0 ? "Left over: " : "Short by: ") + currency + " $" + Math.abs(net).toFixed(2) +
    " after " + currency + " $" + spend.toFixed(2) + " in bills due this month";
}

function saveIncomeEstimate() {
  api("/api/me/income", {
    method: "PUT",
    body: JSON.stringify({ amount: state.user.incomeEstimate, currency: state.user.incomeCurrency })
  }).catch(function(){});
}

function renderBillDashboard() {
  var el = document.getElementById("billPlaceholder");
  if(!el) return;

  var overdue = [], upcoming = [], paid = [];
  var dueTotals = {};
  state.bills.forEach(function(b){
    var status = billStatus(b);
    if(status==="overdue") overdue.push(b);
    else if(status==="paid") paid.push(b);
    else upcoming.push(b);
    if(status!=="paid"){
      dueTotals[b.currency] = (dueTotals[b.currency]||0) + (Number(b.amount)||0);
    }
  });
  function byDueDateThenPriority(a,b){
    var cmp = (a.dueDate||"").localeCompare(b.dueDate||"");
    if(cmp!==0) return cmp;
    return (PRIORITY_ORDER[b.priority]||1) - (PRIORITY_ORDER[a.priority]||1);
  }
  overdue.sort(byDueDateThenPriority);
  upcoming.sort(byDueDateThenPriority);

  var totalsLine = Object.keys(dueTotals).map(function(cur){
    return cur+" $"+dueTotals[cur].toFixed(2);
  }).join(" · ") || "—";

  var forecast = buildBillForecast(state.bills, 12);
  var yearlyTotals = {};
  forecast.forEach(function(f){
    Object.keys(f.totals).forEach(function(cur){
      yearlyTotals[cur] = (yearlyTotals[cur]||0) + f.totals[cur];
    });
  });
  var yearlyLine = forecastTotalsLine(yearlyTotals);
  var thisMonthKey = forecast[0].month;

  function itemRow(b){
    return '<div class="bill-dash-item" data-bill-id="'+b.id+'" style="border-left:2px solid '+b.color+'">'+
      '<span class="bill-dash-item-name">'+esc(b.name)+'</span>'+
      '<span class="bill-dash-item-meta">'+formatDueDate(b.dueDate)+' · '+b.currency+' $'+Number(b.amount).toFixed(2)+'</span>'+
    '</div>';
  }

  function section(title, bills, emptyText){
    var rows = bills.length ? bills.map(itemRow).join("") : '<div class="bill-dash-empty">'+emptyText+'</div>';
    return '<div class="bill-dash-section"><div class="bill-dash-heading">'+title+'</div>'+rows+'</div>';
  }

  function forecastRow(f){
    var isThisMonth = f.month === thisMonthKey;
    return '<div class="bill-dash-forecast-row'+(isThisMonth?" current":"")+'">'+
      '<span class="bill-dash-forecast-month">'+forecastMonthLabel(f.month)+(isThisMonth?' <span class="bill-dash-forecast-tag">This month</span>':'')+'</span>'+
      '<span class="bill-dash-forecast-amount">'+forecastTotalsLine(f.totals)+'</span>'+
    '</div>';
  }

  function categoryRow(entry){
    return '<div class="bill-dash-forecast-row">'+
      '<span class="bill-dash-forecast-month">'+esc(entry.category)+'</span>'+
      '<span class="bill-dash-forecast-amount">'+forecastTotalsLine(entry.totals)+'</span>'+
    '</div>';
  }

  function historyRow(f){
    var isThisMonth = f.month === thisMonthKey;
    return '<div class="bill-dash-forecast-row'+(isThisMonth?" current":"")+'">'+
      '<span class="bill-dash-forecast-month">'+forecastMonthLabel(f.month)+(isThisMonth?' <span class="bill-dash-forecast-tag">This month</span>':'')+'</span>'+
      '<span class="bill-dash-forecast-amount">'+forecastTotalsLine(f.totals)+'</span>'+
    '</div>';
  }

  function breakdownRow(entry){
    var amt = Number(entry.bill.amount);
    var calc = entry.count > 1
      ? entry.count+' × '+entry.bill.currency+' $'+amt.toFixed(2)+' = '+entry.bill.currency+' $'+entry.subtotal.toFixed(2)
      : entry.bill.currency+' $'+entry.subtotal.toFixed(2);
    return '<div class="bill-dash-breakdown-row">'+
      '<span class="bill-dash-breakdown-name">'+esc(entry.bill.name)+' <span class="bill-dash-breakdown-freq">('+entry.bill.frequency+')</span></span>'+
      '<span class="bill-dash-breakdown-calc">'+calc+'</span>'+
    '</div>';
  }

  function breakdownGroup(title, rows){
    if(!rows.length) return '<div class="bill-dash-breakdown-group"><div class="bill-dash-heading">'+title+'</div><div class="bill-dash-empty">Nothing contributing.</div></div>';
    var totals = {};
    rows.forEach(function(r){ totals[r.bill.currency] = (totals[r.bill.currency]||0) + r.subtotal; });
    return '<div class="bill-dash-breakdown-group">'+
      '<div class="bill-dash-heading">'+title+'</div>'+
      rows.map(breakdownRow).join("")+
      '<div class="bill-dash-breakdown-total">Total: '+forecastTotalsLine(totals)+'</div>'+
    '</div>';
  }

  var breakdown = buildBillBreakdown(state.bills, 12);
  var breakdownHtml = state.bills.length
    ? '<div class="bill-dash-section">'+
        '<button class="bill-dash-toggle'+(state.billMathOpen?" open":"")+'" id="billMathToggle">'+
          '<span>How is this calculated?</span>'+
          '<svg class="bill-dash-toggle-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'+
        '</button>'+
        '<div class="bill-dash-breakdown'+(state.billMathOpen?"":" hidden")+'" id="billMathBody">'+
          breakdownGroup("This month ("+forecastMonthLabel(breakdown.thisMonthKey)+")", breakdown.thisMonthRows)+
          breakdownGroup("Next 12 months", breakdown.yearRows)+
        '</div>'+
      '</div>'
    : "";

  var categoryBreakdown = buildCategoryBreakdown(state.bills, 12);
  var paymentHistory = buildPaymentHistory(state.bills, 6);

  var incomeAmount = state.user && state.user.incomeEstimate;
  var incomeCurrency = (state.user && (state.user.incomeCurrency || state.user.defaultCurrency)) || "USD";
  var incomeCurrencyOptions = BILL_CURRENCIES.map(function(c){
    return '<option value="'+c+'"'+(incomeCurrency===c?" selected":"")+'>'+c+'</option>';
  }).join("");

  var statsHtml = state.bills.length
    ? '<div class="bill-dash-stats">'+
        '<div class="bill-dash-stat overdue"><div class="bill-dash-stat-value">'+overdue.length+'</div><div class="bill-dash-stat-label">Overdue</div></div>'+
        '<div class="bill-dash-stat upcoming"><div class="bill-dash-stat-value">'+upcoming.length+'</div><div class="bill-dash-stat-label">Upcoming</div></div>'+
        '<div class="bill-dash-stat paid"><div class="bill-dash-stat-value">'+paid.length+'</div><div class="bill-dash-stat-label">Paid</div></div>'+
        '<div class="bill-dash-stat"><div class="bill-dash-stat-value" style="font-size:15px;">'+totalsLine+'</div><div class="bill-dash-stat-label">Outstanding bills</div></div>'+
        '<div class="bill-dash-stat"><div class="bill-dash-stat-value" style="font-size:15px;">'+yearlyLine+'</div><div class="bill-dash-stat-label">Next 12 months</div></div>'+
      '</div>'+
      breakdownHtml +
      section("Overdue", overdue, "Nothing overdue.") +
      section("Due soon", upcoming.slice(0,5), "Nothing else due.") +
      '<div class="bill-dash-section"><div class="bill-dash-heading">Monthly forecast</div>'+
        forecast.map(forecastRow).join("")+
      '</div>'+
      '<div class="bill-dash-section"><div class="bill-dash-heading">Spend by category (next 12 months)</div>'+
        (categoryBreakdown.length ? categoryBreakdown.map(categoryRow).join("") : '<div class="bill-dash-empty">No categorized bills yet.</div>')+
      '</div>'+
      '<div class="bill-dash-section"><div class="bill-dash-heading">Paid in recent months</div>'+
        paymentHistory.map(historyRow).join("")+
      '</div>'
    : '<div class="bill-dashboard-empty">No bills yet. Add one to see an overview here.</div>';

  el.innerHTML =
    '<div class="bill-dash-header">'+
      '<span class="bill-dash-header-title">Overview</span>'+
      '<button class="help-btn" data-help="bills" title="How this works" aria-label="How this works">?</button>'+
    '</div>'+
    statsHtml +
    '<div class="bill-dash-section">'+
      '<div class="bill-dash-heading">Estimated monthly income</div>'+
      '<div class="bill-dash-income-row">'+
        '<input type="number" id="incomeAmountInput" min="0" step="0.01" placeholder="e.g. 4200" value="'+(incomeAmount!=null?incomeAmount:"")+'" />'+
        '<select id="incomeCurrencyInput">'+incomeCurrencyOptions+'</select>'+
      '</div>'+
      '<div class="bill-dash-net" id="incomeNetLine"></div>'+
    '</div>';

  el.querySelectorAll(".bill-dash-item").forEach(function(item){
    item.addEventListener("click", function(){
      state.selectedBillId = item.getAttribute("data-bill-id");
      renderBillList();
    });
  });

  var billMathToggle = document.getElementById("billMathToggle");
  if(billMathToggle){
    billMathToggle.addEventListener("click", function(){
      state.billMathOpen = !state.billMathOpen;
      billMathToggle.classList.toggle("open", state.billMathOpen);
      document.getElementById("billMathBody").classList.toggle("hidden", !state.billMathOpen);
    });
  }

  var incomeSaveTimer = null;
  document.getElementById("incomeAmountInput").addEventListener("input", function(e){
    var val = e.target.value;
    state.user.incomeEstimate = val === "" ? null : parseFloat(val);
    renderIncomeNetLine();
    clearTimeout(incomeSaveTimer);
    incomeSaveTimer = setTimeout(saveIncomeEstimate, 600);
  });
  document.getElementById("incomeCurrencyInput").addEventListener("change", function(e){
    state.user.incomeCurrency = e.target.value;
    renderIncomeNetLine();
    saveIncomeEstimate();
  });
  renderIncomeNetLine();
}

function renderBillEditor() {
  var bill = state.bills.find(function(b){return b.id===state.selectedBillId;});
  var editorEl = document.getElementById("billEditor");
  if(!bill){
    if(editorEl) editorEl.innerHTML = "";
    return;
  }
  var status = billStatus(bill);
  var statusLabel = status==="paid"?"✅ Paid":status==="overdue"?"⚠️ Overdue":"Upcoming";
  var isLocalAccount = state.user && state.user.authType==="local";

  var priorityBtns = BILL_PRIORITIES.map(function(p){
    return '<button class="bill-priority-btn'+((bill.priority||"medium")===p?" selected":"")+'" data-priority="'+p+'" style="--priority-color:'+PRIORITY_COLORS[p]+'">'+PRIORITY_LABELS[p]+'</button>';
  }).join("");
  var freqOptions = BILL_FREQS.map(function(f){
    return '<option value="'+f.val+'"'+(bill.frequency===f.val?" selected":"")+'>'+f.label+'</option>';
  }).join("");
  var billCategoryList = getBillCategories();
  var catList = (bill.category && billCategoryList.indexOf(bill.category)===-1) ? billCategoryList.concat([bill.category]) : billCategoryList;
  var catOptions = catList.map(function(c){
    return '<option value="'+esc(c)+'"'+(bill.category===c?" selected":"")+'>'+esc(c)+'</option>';
  }).join("");
  var currOptions = BILL_CURRENCIES.map(function(c){
    return '<option value="'+c+'"'+(bill.currency===c?" selected":"")+'>'+c+'</option>';
  }).join("");
  var payBtn = status==="paid"
    ? '<button class="bill-action-btn unpay" id="billUnpayBtn">↩ Mark unpaid</button>'
    : '<button class="bill-action-btn pay-now" id="billPayBtn">✓ Mark as paid</button>';
  var historyHtml = bill.paidDates&&bill.paidDates.length
    ? bill.paidDates.map(function(p){return '<div class="bill-history-item"><span class="bill-history-dot"></span>'+formatDueDate(p.date)+'<span style="margin-left:auto;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--ink-dim);">'+esc(bill.currency)+' $'+Number(p.amount||0).toFixed(2)+'</span></div>';}).join("")
    : '<div class="bill-history-empty">No payments recorded yet.</div>';

  editorEl.innerHTML =
    '<div class="bill-editor-head">'+
      '<div class="bill-editor-toprow">'+
        '<button class="icon-btn" id="billBackBtn" aria-label="Back to overview" title="Back to overview">'+
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'+
        '</button>'+
        '<input class="bill-name-input" id="billNameInput" placeholder="Bill name" value="'+esc(bill.name)+'" />'+
        '<div class="bill-editor-actions">'+
          payBtn+
          '<button class="bill-action-btn'+(isLocalAccount?' hidden':'')+'" id="billSendDmBtn">📨 DM</button>'+
          '<button class="bill-action-btn del" id="billDeleteBtn">🗑</button>'+
        '</div>'+
      '</div>'+
      '<div style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--ink-dim);">'+
        statusLabel+(bill.dueDate?" · Due "+formatDueDate(bill.dueDate):"")+(bill.autoPay?" · Auto-pay":"")+
      '</div>'+
    '</div>'+
    '<div class="bill-editor-body">'+
      '<div class="bill-form-grid">'+
        '<div class="bill-field"><label>Amount</label>'+
          '<div class="bill-amount-row">'+
            '<input type="number" id="billAmount" min="0" step="0.01" value="'+Number(bill.amount).toFixed(2)+'" />'+
            '<select id="billCurrency">'+currOptions+'</select>'+
          '</div>'+
        '</div>'+
        '<div class="bill-field"><label>Due date</label>'+
          '<input type="date" id="billDueDate" value="'+(bill.dueDate||"")+'" /></div>'+
        '<div class="bill-field"><label>Frequency</label><select id="billFrequency">'+freqOptions+'</select></div>'+
        '<div class="bill-field"><label>Category</label><select id="billCategory">'+catOptions+'</select></div>'+
        '<div class="bill-field"><label>Website / URL</label>'+
          '<div class="bill-url-row">'+
            '<input type="url" id="billUrl" placeholder="https://…" value="'+esc(bill.url||"")+'" />'+
            (bill.url && /^https?:\/\//i.test(bill.url)
              ? '<a class="bill-url-open" href="'+esc(bill.url)+'" target="_blank" rel="noopener noreferrer" title="Open link">↗</a>'
              : '')+
          '</div></div>'+
        '<div class="bill-field'+(isLocalAccount?' hidden':'')+'"><label>Remind me (days before)</label>'+
          '<input type="number" id="billReminderDays" min="0" max="30" placeholder="e.g. 3" value="'+(bill.reminderDays!=null?bill.reminderDays:"")+'" /></div>'+
        '<div class="bill-field full"><label>Auto-pay</label>'+
          '<div class="bill-toggle-row">'+
            '<input type="checkbox" id="billAutoPay"'+(bill.autoPay?" checked":"")+' />'+
            '<label for="billAutoPay">This bill is paid automatically</label>'+
          '</div></div>'+
        '<div class="bill-field full"><label>Priority</label>'+
          '<div class="bill-priority-row" id="billPriorityRow">'+priorityBtns+'</div></div>'+
        '<div class="bill-field full"><label>Notes</label>'+
          '<textarea id="billNotes" placeholder="Any extra details…">'+esc(bill.notes||"")+'</textarea></div>'+
      '</div>'+
      '<div class="bill-history">'+
        '<div class="bill-history-title">Payment history</div>'+historyHtml+
      '</div>'+
    '</div>';

  function saveBill() {
    var remVal = document.getElementById("billReminderDays").value;
    api("/api/bills/"+bill.id,{method:"PUT",body:JSON.stringify({
      name:         document.getElementById("billNameInput").value,
      amount:       parseFloat(document.getElementById("billAmount").value)||0,
      currency:     document.getElementById("billCurrency").value,
      dueDate:      document.getElementById("billDueDate").value||null,
      frequency:    document.getElementById("billFrequency").value,
      category:     document.getElementById("billCategory").value,
      url:          document.getElementById("billUrl").value,
      reminderDays: remVal!==""?parseInt(remVal,10):null,
      autoPay:      document.getElementById("billAutoPay").checked,
      notes:        document.getElementById("billNotes").value,
      priority:     bill.priority
    })}).then(function(updated){
      var idx=state.bills.findIndex(function(b){return b.id===updated.id;});
      if(idx>-1){state.bills[idx]=updated; bill=updated;}
      renderBillList({keepEditor:true});
    });
  }

  var saveTimer=null;
  function debounceSave(){ clearTimeout(saveTimer); saveTimer=setTimeout(saveBill,500); }
  ["billNameInput","billAmount","billCurrency","billDueDate","billFrequency","billCategory","billUrl","billReminderDays","billNotes"].forEach(function(id){
    var el=document.getElementById(id); if(el) el.addEventListener("input",debounceSave);
  });
  document.getElementById("billAutoPay").addEventListener("change",saveBill);

  document.getElementById("billPriorityRow").querySelectorAll(".bill-priority-btn").forEach(function(btn){
    btn.addEventListener("click",function(){
      bill.priority=btn.getAttribute("data-priority");
      bill.color=PRIORITY_COLORS[bill.priority];
      saveBill();
      document.querySelectorAll(".bill-priority-btn").forEach(function(b){b.classList.remove("selected");});
      btn.classList.add("selected");
    });
  });

  var payBtnEl=document.getElementById("billPayBtn");
  if(payBtnEl) payBtnEl.addEventListener("click",function(){
    api("/api/bills/"+bill.id+"/pay",{method:"POST"}).then(function(updated){
      var idx=state.bills.findIndex(function(b){return b.id===updated.id;});
      if(idx>-1) state.bills[idx]=updated;
      renderBillList();
      showToast("Marked as paid ✓");
    });
  });
  var unpayBtnEl=document.getElementById("billUnpayBtn");
  if(unpayBtnEl) unpayBtnEl.addEventListener("click",function(){
    api("/api/bills/"+bill.id+"/unpay",{method:"POST"}).then(function(updated){
      var idx=state.bills.findIndex(function(b){return b.id===updated.id;});
      if(idx>-1) state.bills[idx]=updated;
      renderBillList();
      showToast("Marked as unpaid");
    });
  });
  document.getElementById("billSendDmBtn").addEventListener("click",function(){
    api("/api/bills/"+bill.id+"/send-dm",{method:"POST"})
      .then(function(){showToast("Bill sent to your DMs 📨");})
      .catch(function(){showToast("Failed. Is the bot configured?");});
  });
  document.getElementById("billDeleteBtn").addEventListener("click",function(){
    openConfirm("Delete \""+bill.name+"\"? You can restore it from Settings for 30 days.",{type:"deleteBill",id:bill.id});
  });
  document.getElementById("billBackBtn").addEventListener("click",function(){
    state.selectedBillId = null;
    renderBillList();
  });
}

function addBill() {
  // If we're not already on Bills, switch there first so the new bill's editor
  // has somewhere to render.
  var wasBills = state.view === "bills";
  var finish = function(bill){
    state.bills.unshift(bill);
    state.selectedBillId=bill.id;
    document.getElementById("app").classList.add("show-bills");
    renderBillList();
    var el=document.getElementById("billNameInput");
    if(el){el.select();el.focus();}
  };
  var create = function(){
    api("/api/bills",{method:"POST",body:JSON.stringify({name:"New bill",frequency:"monthly",currency:(state.user&&state.user.defaultCurrency)||"USD"})}).then(finish);
  };
  if(wasBills) create();
  else { switchView("bills"); create(); }
}

document.getElementById("addBillBtn").addEventListener("click", addBill);

boot();
})();
