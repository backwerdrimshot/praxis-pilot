/* =====================================================================
   PraxisState — deterministic skill-state + next-action engine
   Doc 16 (Pilot v0.1), step 6. Doc 17 canonical state list.

   State is DERIVED from immutable evidence (the ledger profile), teacher
   decisions (pass-off records), and retention dates — apps never write
   state directly. Pure functions, no DOM, no storage: fully testable.

   States (doc 16 / 17):
     not-started · introduced · evidence-collected · needs-retry ·
     ready-for-teacher · teacher-verified · review-due · retained

   v0.1 note: teacher-verified / review-due / retained depend on a pass-off
   record (praxis.passoffs.v0_1) and a retention date. Those inputs are
   optional here; with no pass-off the engine derives the digital-side
   states (up to ready-for-teacher), which is all v0.1 needs today.
   ===================================================================== */
(function(global){
"use strict";

const LABELS={
  "not-started":"Not started",
  "introduced":"Introduced",
  "evidence-collected":"Evidence collected",
  "needs-retry":"Needs retry",
  "ready-for-teacher":"Ready for teacher",
  "teacher-verified":"Teacher verified",
  "review-due":"Review due",
  "retained":"Retained"
};

/* Per-skill knowledge threshold for readiness (doc 16 thresholds):
   single paradiddle 100%, the two rolls 75%. Override via opts.knowledgeReady. */
function defaultKnowledgeReady(skillId){
  return skillId==="rudiment.single-paradiddle.core"?100:75;
}

/* profile: the shape returned by PraxisResults.profile(skillId):
     { knowledge:{score}|null, recall:{score,qualifying}|null,
       sequence:{score,qualifying}|null }
   opts: { skillId, knowledgeReady?, passoff?, retention?, introduced? }
     passoff:  { outcome:"pass"|"coaching"|"retry", at } | null
     retention:{ due:boolean, passed:boolean|null } | null
     introduced: boolean — student has opened the task (optional signal)
*/
function evaluate(profile, opts){
  opts=opts||{};
  profile=profile||{};
  const skillId=opts.skillId;
  const kReady=opts.knowledgeReady!=null?opts.knowledgeReady:defaultKnowledgeReady(skillId);
  const passoff=opts.passoff||null;
  const retention=opts.retention||null;

  const k=profile.knowledge, r=profile.recall, s=profile.sequence;
  const hasAny=!!(k||r||s);

  // digital prerequisites for a pass-off (doc 16): knowledge at/above the
  // skill threshold AND an exact, reliability-verified controller sequence.
  const knowledgeOk = !!k && k.score>=kReady;
  const sequenceOk  = !!s && s.qualifying===true && s.score===100;
  const digitalReady = knowledgeOk && sequenceOk;

  // anything attempted that is below its bar → a retry is the right move
  const knowledgeBelow = !!k && k.score<kReady;
  const sequenceBad    = !!s && (s.qualifying!==true || s.score<100);

  // ---- teacher + retention layer (only when a pass-off exists) ----
  if(passoff && passoff.outcome==="pass"){
    if(retention && retention.due){
      if(retention.passed===true)  return build("retained", nextFor("retained"), skillId);
      if(retention.passed===false) return build("needs-retry", nextFor("review-failed"), skillId);
      return build("review-due", nextFor("review-due"), skillId);
    }
    return build("teacher-verified", nextFor("teacher-verified"), skillId);
  }
  // a teacher asked for coaching / retry sends it back to needs-retry
  if(passoff && (passoff.outcome==="coaching"||passoff.outcome==="retry")){
    return build("needs-retry", {txt:"Your teacher asked for a retry — see their note, then rework it.",
      app:"copy-the-sticking", cta:"Rework"}, skillId);
  }

  // ---- digital-only layer ----
  if(digitalReady) return build("ready-for-teacher", nextFor("ready-for-teacher"), skillId);
  if(!hasAny)      return build(opts.introduced?"introduced":"not-started",
                                nextKnowledge(), skillId);

  // something exists; decide retry vs. still-collecting
  if(!k)              return build("evidence-collected", nextKnowledge(), skillId);
  if(knowledgeBelow)  return build("needs-retry",
    {txt:`Review the sticking, then retry the knowledge check (need ${kReady}%).`,
     app:"count-it-contract", cta:"Retry knowledge check"}, skillId);
  // knowledge is fine here; look at the controller side
  if(!s)              return build("evidence-collected",
    {txt:"Run the input test, then enter the pattern through the triggers.",
     app:"copy-the-sticking", cta:"Trigger challenge"}, skillId);
  if(s.qualifying!==true) return build("needs-retry",
    {txt:"Re-run the reliability test so the controller result can count.",
     app:"copy-the-sticking", cta:"Re-test & retry"}, skillId);
  if(s.score<100)     return build("needs-retry",
    {txt:"Practice a shorter first half, then retry the challenge.",
     app:"copy-the-sticking", cta:"Practice / retry"}, skillId);

  return build("evidence-collected", nextKnowledge(), skillId);
}

function nextKnowledge(){
  return {txt:"Start with the knowledge check.", app:"count-it-contract", cta:"Knowledge check"};
}
function nextFor(kind){
  switch(kind){
    case "ready-for-teacher": return {txt:"Digital prerequisites met — ready for the teacher pass-off.", app:null, ready:true};
    case "teacher-verified":  return {txt:"Teacher verified. A retention check will come later.", app:null, ready:false};
    case "review-due":        return {txt:"Retention check due — complete a short review to keep it.", app:"copy-the-sticking", cta:"Review"};
    case "review-failed":     return {txt:"Retention check missed — refresh the pattern and retry.", app:"copy-the-sticking", cta:"Refresh"};
    case "retained":          return {txt:"Retained — verified and held over time.", app:null, ready:false};
    default:                  return nextKnowledge();
  }
}
function build(state, nextAction, skillId){
  return {state, label:LABELS[state], skillId, ready:state==="ready-for-teacher", nextAction};
}

global.PraxisState={evaluate, LABELS, defaultKnowledgeReady, version:"0.1.0"};
})(typeof window!=="undefined"?window:globalThis);
