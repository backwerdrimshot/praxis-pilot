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

   Storage is injectable (localStorage by default; in-memory for tests), so
   the whole thing is deterministically testable with no DOM.
   Apps EMIT evidence into the ledger; they never write mastery or pass-offs.
   ===================================================================== */
(function(global){
"use strict";

const LEDGER_KEY="praxis.results.v0_1";
const QUAR_KEY="praxis.results.v0_1.quarantine";
const LEGACY_KEYS=["praxis.cia1.v1","praxis.cts.v1"];

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
  const write=(k,v)=>{ try{store.setItem(k,JSON.stringify(v));}catch(e){} };

  const all=()=>read(LEDGER_KEY);
  const quarantined=()=>read(QUAR_KEY);
  const has=attemptId=>all().some(r=>r.attemptId===attemptId);

  function append(result){
    const v=validate(result);
    if(!v.ok){
      const q=quarantined();
      q.push({at:new Date().toISOString(), attemptId:result&&result.attemptId, reasons:v.errors, result});
      write(QUAR_KEY,q);
      return {status:"quarantined", reasons:v.errors};
    }
    const led=all();
    if(led.some(r=>r.attemptId===result.attemptId)) return {status:"duplicate"};
    led.push(result); write(LEDGER_KEY,led);
    return {status:"added"};
  }

  const bySkill=skillId=>all().filter(r=>r.skillId===skillId);
  const latestBySkill=skillId=>bySkill(skillId).reduce((a,b)=>(!a||b.completedAt>a.completedAt)?b:a, null);

  /* Import qualifying attempts from the two prototype stores into the ledger,
     without deleting the originals. Idempotent (dedup by attemptId). */
  function migrateLegacy(){
    let imported=0, skipped=0, quar=0;
    for(const key of LEGACY_KEYS){
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

  const clear=()=>{ write(LEDGER_KEY,[]); write(QUAR_KEY,[]); };

  return {append, all, bySkill, latestBySkill, quarantined, migrateLegacy, profile, has, clear,
    LEDGER_KEY, QUAR_KEY};
}

global.PraxisResults={create, validate, memoryStore, version:"0.1.0",
  LEDGER_KEY, QUAR_KEY, LEGACY_KEYS, REQUIRED};
})(typeof window!=="undefined"?window:globalThis);
