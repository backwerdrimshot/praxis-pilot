/* =====================================================================
   PraxisResults — shared result contract + append-only ledger
   Doc 16 (Pilot v0.1 Build Brief), build steps 1–2.

   One same-origin source of truth for cross-app evidence:
     - validate(result)  → checks the praxis.result.v0_1 envelope
     - ledger.append()   → adds valid results (dedup by attemptId),
                            quarantines malformed ones (never silently drops)
     - ledger.migrateLegacy() → imports the two prototype stores
                            (praxis.cia1.v1, praxis.cts.v1) without deleting them
     - ledger.profile(skillId) → combined evidence dimensions, kept separate
     - ledger.stats()    → sizes + caps + how much was dropped (for the export)

   Storage is injectable (localStorage by default; in-memory for tests), so
   the whole thing is deterministically testable with no DOM.
   Apps EMIT evidence into the ledger; they never write mastery or pass-offs.
   ===================================================================== */
(function(global){
"use strict";

const LEDGER_KEY="praxis.results.v0_1";
const QUAR_KEY="praxis.results.v0_1.quarantine";
const META_KEY="praxis.results.v0_1.meta";
const LEGACY_KEYS=["praxis.cia1.v1","praxis.cts.v1"];

/* Ledger caps (bug: uncapped ledger could hit the localStorage quota over a long
   shared-device pilot, and a quota failure would silently stop recording — the
   evidence the pilot exists to produce). FIFO: newest kept, oldest dropped, and
   every drop is COUNTED in meta so an export can say evidence was trimmed.
   500 results ≈ well under quota at ~1 KB/result while far exceeding a pilot's
   per-learner volume (a few dozen attempts). */
const MAX_RESULTS=500;
const MAX_QUARANTINE=50;

/* Required top-level fields of the praxis.result.v0_1 envelope (doc 16). */
const REQUIRED=["resultVersion","contract","appId","activityId","activityVersion",
  "scoringRuleVersion","attemptId","skillId","skillVersion","mode","inputSource",
  "deviceTest","evidence","settings","startedAt","completedAt"];

function memoryStore(){
  const m=Object.create(null);
  return { getItem:k=>k in m?m[k]:null, setItem:(k,v)=>{m[k]=String(v);}, removeItem:k=>{delete m[k];} };
}

/* Validate a result envelope. Returns {ok, errors[]}. The ingestion layer must
   reject/quarantine — never silently reinterpret (doc 16 / doc 17). */
function validate(r){
  const errors=[];
  if(!r||typeof r!=="object") return {ok:false,errors:["not an object"]};
  if(r.contract!=="praxis.result.v0_1") errors.push("contract must be praxis.result.v0_1");
  if(r.resultVersion!==1) errors.push("resultVersion must be 1");
  for(const f of REQUIRED) if(r[f]===undefined||r[f]===null) errors.push("missing "+f);
  if(typeof r.attemptId!=="string"||!r.attemptId) errors.push("attemptId must be a non-empty string");
  if(!Array.isArray(r.evidence)||r.evidence.length===0) errors.push("evidence must be a non-empty array");
  else r.evidence.forEach((e,i)=>{
    if(!e||typeof e!=="object"){ errors.push(`evidence[${i}] not an object`); return; }
    if(typeof e.evidenceType!=="string") errors.push(`evidence[${i}].evidenceType missing`);
    if(e.outcome===undefined&&e.score===undefined&&e.accuracy===undefined)
      errors.push(`evidence[${i}] needs outcome or score/accuracy`);
    if(typeof e.measured!=="string") errors.push(`evidence[${i}].measured missing`);
    if(typeof e.notMeasured!=="string") errors.push(`evidence[${i}].notMeasured missing`);
    if(!Array.isArray(e.validity)) errors.push(`evidence[${i}].validity must be an array`);
  });
  return {ok:errors.length===0, errors};
}

function create(opts){
  opts=opts||{};
  const store=opts.storage||(global.localStorage||memoryStore());
  const read=k=>{ try{const s=store.getItem(k); return s?JSON.parse(s):[];}catch(e){return [];} };
  /* Returns false when the write failed (quota). Callers must not ignore it —
     a swallowed quota error is exactly how recording stops silently. */
  const write=(k,v)=>{ try{store.setItem(k,JSON.stringify(v)); return true;}catch(e){ return false; } };

  /* Optional per-learner namespace (doc 14d shared devices): keySuffix like
     "::P03" scopes the ledger, quarantine, and the legacy stores it migrates. */
  const sfx=opts.keySuffix||"";
  const LK=LEDGER_KEY+sfx, QK=QUAR_KEY+sfx, MK=META_KEY+sfx, LEG=LEGACY_KEYS.map(k=>k+sfx);

  const maxResults=opts.maxResults!=null?opts.maxResults:MAX_RESULTS;
  const maxQuarantine=opts.maxQuarantine!=null?opts.maxQuarantine:MAX_QUARANTINE;

  const all=()=>read(LK);
  const quarantined=()=>read(QK);
  const has=attemptId=>all().some(r=>r.attemptId===attemptId);

  /* Trim/meta ---------------------------------------------------------
     meta is a plain object (not an array), so it gets its own read path. */
  function readMeta(){
    try{ const s=store.getItem(MK); const o=s?JSON.parse(s):null;
      return (o&&typeof o==="object"&&!Array.isArray(o))?o:{}; }catch(e){ return {}; }
  }
  function bumpMeta(patch){
    const m=readMeta();
    m.droppedResults=(m.droppedResults||0)+(patch.droppedResults||0);
    m.droppedQuarantine=(m.droppedQuarantine||0)+(patch.droppedQuarantine||0);
    if(patch.droppedResults||patch.droppedQuarantine) m.lastDropAt=new Date().toISOString();
    if(patch.storageFull) m.lastStorageFullAt=new Date().toISOString();
    write(MK,m);
    return m;
  }
  /* FIFO: keep the newest `max`, return how many were dropped off the front. */
  function trim(arr,max){
    if(max<=0||arr.length<=max) return 0;
    const drop=arr.length-max;
    arr.splice(0,drop);
    return drop;
  }

  function append(result){
    const v=validate(result);
    if(!v.ok){
      const q=quarantined();
      q.push({at:new Date().toISOString(), attemptId:result&&result.attemptId, reasons:v.errors, result});
      const dropped=trim(q,maxQuarantine);
      const ok=write(QK,q);
      if(dropped) bumpMeta({droppedQuarantine:dropped});
      if(!ok) bumpMeta({storageFull:true});
      return {status:"quarantined", reasons:v.errors, dropped, stored:ok};
    }
    const led=all();
    if(led.some(r=>r.attemptId===result.attemptId)) return {status:"duplicate"};
    led.push(result);
    let dropped=trim(led,maxResults);
    if(write(LK,led)){
      if(dropped) bumpMeta({droppedResults:dropped});
      return {status:"added", dropped};
    }
    /* Quota hit even under the cap (other keys crowding the origin, or unusually
       large results). Drop the oldest half and retry once — losing old evidence
       beats losing the attempt the student just made. */
    const extra=trim(led,Math.floor(led.length/2));
    if(extra>0&&write(LK,led)){
      bumpMeta({droppedResults:dropped+extra, storageFull:true});
      return {status:"added", dropped:dropped+extra, storageFull:true};
    }
    /* Nothing was persisted, so the stored ledger is untouched — count no drops,
       only the failure. The attempt itself is what was lost. */
    bumpMeta({storageFull:true});
    return {status:"storage-full", dropped:0, stored:false};
  }

  /* Honest counts for the teacher export: says whether evidence was trimmed. */
  function stats(){
    const m=readMeta();
    return {results:all().length, quarantined:quarantined().length,
      maxResults, maxQuarantine,
      droppedResults:m.droppedResults||0, droppedQuarantine:m.droppedQuarantine||0,
      lastDropAt:m.lastDropAt||null, lastStorageFullAt:m.lastStorageFullAt||null};
  }

  const bySkill=skillId=>all().filter(r=>r.skillId===skillId);
  const latestBySkill=skillId=>bySkill(skillId).reduce((a,b)=>(!a||b.completedAt>a.completedAt)?b:a, null);

  /* Import qualifying attempts from the two prototype stores into the ledger,
     without deleting the originals. Idempotent (dedup by attemptId). */
  function migrateLegacy(){
    let imported=0, skipped=0, quar=0;
    for(const key of LEG){
      let obj=null; try{const s=store.getItem(key); obj=s?JSON.parse(s):null;}catch(e){}
      const attempts=(obj&&Array.isArray(obj.attempts))?obj.attempts:[];
      for(const a of attempts){
        const res=append(a);
        if(res.status==="added") imported++;
        else if(res.status==="duplicate") skipped++;
        else quar++;
      }
    }
    return {imported, skipped, quarantined:quar};
  }

  /* Combined skill profile: latest evidence per dimension, kept SEPARATE
     (never collapsed into one number). Qualifying = no disqualifying flag. */
  function profile(skillId){
    const rs=bySkill(skillId);
    const disqualified=ev=>Array.isArray(ev.validity)&&ev.validity.some(v=>/not qualifying|not passed/i.test(v));
    const pick=(evPred,appPred)=>{
      let best=null;
      for(const r of rs){
        if(appPred&&!appPred(r)) continue;
        const ev=r.evidence.find(evPred); if(!ev) continue;
        if(!best||r.completedAt>best.r.completedAt) best={r,ev};
      }
      return best;
    };
    const knowledge=pick(e=>e.evidenceType==="A1_ANSWER_CORRECTNESS", r=>/count-it/.test(r.appId));
    const recall   =pick(e=>e.evidenceType==="A1_ANSWER_CORRECTNESS", r=>/stick/.test(r.appId));
    const sequence =pick(e=>e.evidenceType==="A2_CONTROLLER_SEQUENCE", null);
    return {
      knowledge: knowledge?{score:knowledge.ev.score, appId:knowledge.r.appId}:null,
      recall:    recall?{score:recall.ev.score, appId:recall.r.appId, qualifying:!disqualified(recall.ev)}:null,
      sequence:  sequence?{score:(sequence.ev.accuracy!=null?sequence.ev.accuracy:sequence.ev.score),
                           appId:sequence.r.appId, qualifying:!disqualified(sequence.ev)}:null
    };
  }

  const clear=()=>{ write(LK,[]); write(QK,[]); write(MK,{}); };

  return {append, all, bySkill, latestBySkill, quarantined, migrateLegacy, profile, has, clear,
    stats, LEDGER_KEY, QUAR_KEY, META_KEY};
}

global.PraxisResults={create, validate, memoryStore, version:"0.2.0",
  LEDGER_KEY, QUAR_KEY, META_KEY, LEGACY_KEYS, REQUIRED, MAX_RESULTS, MAX_QUARANTINE};
})(typeof window!=="undefined"?window:globalThis);
