/* =====================================================================
   PraxisLearner — pseudonymous learner code for shared devices
   Doc 14d (teacher-issued pseudonymous identifiers) + doc 16 shared-device
   handling. This is a LOCAL namespace, not an account: no server, no PII.

   When a code is active, every per-learner store is suffixed with "::CODE"
   so a shared Chromebook keeps each student's evidence separate. With no
   code set, the base keys are used (single-device / "practice" mode) — so
   existing data and single-device use keep working unchanged.

   Surfaces call PraxisLearner.key(baseKey) for their stores, pass
   PraxisLearner.suffix() to PraxisResults.create({keySuffix}), and call
   mountBar() to render a consistent "Learner: X · Switch" control.
   ===================================================================== */
(function(global){
"use strict";

const CURRENT_KEY="praxis.learner.current";
const store = global.localStorage;

/* Codes are pseudonymous, short, and PII-free by construction. */
function normalize(raw){
  if(raw==null) return "";
  return String(raw).trim().toUpperCase().replace(/[^A-Z0-9._-]/g,"").slice(0,16);
}

function current(){
  try{ const c=store?store.getItem(CURRENT_KEY):null; return c||null; }catch(e){ return null; }
}
function suffix(){ const c=current(); return c?"::"+c:""; }
function key(base){ return base+suffix(); }

function set(raw){
  const code=normalize(raw);
  if(!code) return {ok:false, error:"Enter a short code (letters/numbers), no names."};
  try{ store.setItem(CURRENT_KEY, code); }catch(e){ return {ok:false, error:"This device can't save (private mode)."}; }
  return {ok:true, code};
}
function clear(){ try{ store.removeItem(CURRENT_KEY); }catch(e){} }

/* Enumerate the learner codes that have any results on this device
   (for the teacher's "export all" and switcher). Scans the results ledger. */
function knownCodes(){
  const base="praxis.results.v0_1", codes=new Set();
  try{
    for(let i=0;i<store.length;i++){
      const k=store.key(i);
      if(k===base) codes.add(null);                 // the no-code namespace
      else if(k && k.indexOf(base+"::")===0) codes.add(k.slice((base+"::").length));
    }
  }catch(e){}
  return [...codes];
}

/* Render a consistent learner bar. Prepends to `container` (default: .wrap).
   opts.compact renders inline text only (for tight headers). */
function mountBar(container, opts){
  opts=opts||{};
  const host = (typeof container==="string"?document.querySelector(container):container)
             || document.querySelector(".wrap") || document.body;
  const code=current();
  const bar=document.createElement("div");
  bar.className="praxis-learner-bar";
  bar.style.cssText="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"+
    "font-size:12.5px;color:#9AA3B2;background:#0b0d12;border:1px solid #2A2F3B;"+
    "border-radius:10px;padding:8px 12px;margin:0 0 16px";
  const label=code
    ? `<span>Learner: <b style="color:#E8EBF2;font-family:ui-monospace,Menlo,monospace">${code}</b></span>`
    : `<span>Practice mode — <b style="color:#E8EBF2">no learner code</b> (data is shared on this browser)</span>`;
  bar.innerHTML=`${label}
    <span style="margin-left:auto;display:flex;gap:8px">
      <button class="pl-set" style="font:inherit;cursor:pointer;border:1px solid #5B8CFF;color:#cfe0ff;background:transparent;border-radius:8px;padding:5px 10px">${code?"Switch student":"Set learner code"}</button>
      ${code?`<button class="pl-clear" style="font:inherit;cursor:pointer;border:none;background:none;color:#9AA3B2;text-decoration:underline">exit</button>`:""}
    </span>`;
  host.insertBefore(bar, host.firstChild);
  bar.querySelector(".pl-set").addEventListener("click",()=>{
    const raw=prompt("Enter the teacher-issued learner code (a pseudonym like P03 — no names):", code||"");
    if(raw==null) return;
    const res=set(raw);
    if(!res.ok){ alert(res.error); return; }
    (opts.onChange||(()=>location.reload()))(res.code);
  });
  const clr=bar.querySelector(".pl-clear");
  if(clr) clr.addEventListener("click",()=>{
    if(confirm("Exit this learner? You'll return to shared practice mode (this device's un-coded data).")){
      clear(); (opts.onChange||(()=>location.reload()))(null);
    }
  });
  return bar;
}

global.PraxisLearner={current, suffix, key, set, clear, normalize, knownCodes, mountBar,
  CURRENT_KEY, version:"0.1.0"};
})(typeof window!=="undefined"?window:globalThis);
