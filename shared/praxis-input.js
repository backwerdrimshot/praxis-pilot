/* =====================================================================
   PraxisInput — shared two-trigger input manager
   Doc 13 (Controller Input & Trigger Architecture), Phase 1.

   Games consume ACTIONS (LEFT_HAND / RIGHT_HAND), never devices.
   Adapters normalize keyboard + touch into TriggerEvent:
     { source, action, controlId, timestampMs, value, pressed }

   Contracts honored (doc 13 key-binding rules):
   - bind by physical KeyboardEvent.code (label fallback only when a
     synthetic keyboard/IME sends an empty code)
   - held-key repeats never generate answers
   - typing in text fields is never captured
   - browser default prevented only for mapped keys on an active surface
   - reserved browser/system keys cannot be bound
   - pressed-state clears on blur/hidden so no key sticks
   - configurable per-control refractory window (encoder chatter)

   Test hook: injectKey()/press() accept explicit timestamps, so a
   recorded normalized event sequence can be replayed deterministically.
   No DOM required until attach().
   ===================================================================== */
(function(global){
"use strict";

const RESERVED=new Set(["Tab","Escape","Enter","NumpadEnter","Space","Backspace","CapsLock","ContextMenu",
  "MetaLeft","MetaRight","ControlLeft","ControlRight","AltLeft","AltRight","OSLeft","OSRight",
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12","PrintScreen","Delete"]);

const HANDS=["L","R"];
const HAND_ACTION={L:"LEFT_HAND",R:"RIGHT_HAND"};

function keyLabel(e){
  if(e.key===" ") return "Space";
  return e.key&&e.key.length===1?e.key.toUpperCase():(e.key||"");
}
function effCode(e){ return e.code||("key:"+(e.key||"").toLowerCase()); }
function isTextTarget(t){ return !!t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA"||t.isContentEditable); }
function defaultBindings(){
  return {L:[{code:"KeyF",label:"F"},null], R:[{code:"KeyJ",label:"J"},null]};
}

function create(opts){
  opts=opts||{};
  let bindings=opts.bindings||defaultBindings();
  let refractoryMs=opts.refractoryMs!=null?opts.refractoryMs:25;
  let activeSurface=null;          // null | any string; gates preventDefault + focus-loss reporting
  let captureSlot=null;            // e.g. "L0","R1"
  let bounceCount=0;
  const pressed=new Set();         // effective codes currently down
  const lastDownAt=Object.create(null); // controlId -> last accepted-press timestamp
  const cb={
    onTrigger:opts.onTrigger||function(){},
    onBindingsChange:opts.onBindingsChange||function(){},
    onCaptureChange:opts.onCaptureChange||function(){},
    onFocusLoss:opts.onFocusLoss||function(){}
  };
  const doc=opts.doc; // bound in attach(); optional until then
  let attached=false, docRef=null;

  /* ---------- bindings ---------- */
  function getBindings(){ return bindings; }
  function setBindings(b){ bindings=b; cb.onBindingsChange(); }
  function clearBinding(hand,index){ bindings[hand][index]=null; cb.onBindingsChange(); }
  function resetBindings(){ setBindings(defaultBindings()); }
  function bindingsSig(){
    return HANDS.map(h=>bindings[h].map(b=>b?b.code:"·").join("+")).join("/");
  }
  function eventToAction(e){
    const code=effCode(e), lbl=keyLabel(e).toLowerCase();
    for(const h of HANDS) for(const b of bindings[h])
      if(b&&(b.code===code||(!e.code&&b.label.toLowerCase()===lbl)))
        return HAND_ACTION[h];
    return null;
  }

  /* ---------- capture (remap) ---------- */
  function beginCapture(slot){
    captureSlot=slot;
    cb.onCaptureChange({state:"capturing",slot,hand:slot[0],index:+slot[1]});
  }
  function cancelCapture(){
    if(captureSlot===null) return;
    const slot=captureSlot; captureSlot=null;
    cb.onCaptureChange({state:"cancelled",slot});
  }
  function isCapturing(){ return captureSlot!==null; }
  function handleCaptureKey(e){
    e.preventDefault&&e.preventDefault();
    e.stopImmediatePropagation&&e.stopImmediatePropagation();
    const slot=captureSlot, label=keyLabel(e);
    if(e.code==="Escape"||e.key==="Escape"){ cancelCapture(); return; }
    if(RESERVED.has(e.code)||RESERVED.has(label)){
      captureSlot=null;
      cb.onCaptureChange({state:"rejected",slot,label,reason:"reserved"});
      return;
    }
    const code=effCode(e);
    const taken=HANDS.some(h=>bindings[h].some(b=>b&&b.code===code));
    if(taken){
      captureSlot=null;
      cb.onCaptureChange({state:"rejected",slot,label,reason:"taken"});
      return;
    }
    const hand=slot[0], index=+slot[1];
    bindings[hand][index]={code,label};
    captureSlot=null;
    cb.onBindingsChange();
    cb.onCaptureChange({state:"done",slot,hand,index,label,binding:bindings[hand][index]});
  }

  /* ---------- surfaces / stuck-state ---------- */
  function setActiveSurface(s){ activeSurface=s; }
  function getActiveSurface(){ return activeSurface; }
  function clearPressed(reason){
    pressed.clear();
    if(activeSurface) cb.onFocusLoss({reason:reason||"blur"});
  }

  /* ---------- refractory / emit core ---------- */
  function acceptPress(controlId,at){
    const t=at!=null?at:(global.performance?performance.now():Date.now());
    const last=lastDownAt[controlId];
    if(last!=null&&t-last<refractoryMs){ bounceCount++; return null; }
    lastDownAt[controlId]=t;
    return t;
  }

  /* ---------- keyboard adapter ---------- */
  /* injectKey mirrors the real listener exactly; tests call it with
     plain objects carrying explicit timestamps. Returns what happened. */
  function injectKey(type,e){
    if(type==="keyup"){ pressed.delete(effCode(e)); return "keyup"; }
    if(captureSlot!==null){ handleCaptureKey(e); return "capture"; }
    if(isTextTarget(e.target)) return "text-target";
    const action=eventToAction(e);
    if(!action) return "unmapped";
    if(activeSurface&&e.preventDefault) e.preventDefault();
    if(e.repeat) return "repeat";
    const code=effCode(e);
    const t=acceptPress(code,e.at);
    if(t===null) return "bounce";
    if(pressed.has(code)) return "held";
    pressed.add(code);
    cb.onTrigger({source:"keyboard",action,controlId:code,timestampMs:t,value:1,pressed:true});
    return "emitted";
  }

  /* ---------- touch / programmatic adapter (on-screen pads etc.) ---------- */
  function press(action,source,controlId,at){
    const t=acceptPress(controlId,at);
    if(t===null) return "bounce";
    cb.onTrigger({source:source||"touch",action,controlId,timestampMs:t,value:1,pressed:true});
    return "emitted";
  }

  /* ---------- DOM wiring ---------- */
  const onKeyDown=e=>injectKey("keydown",e);
  const onKeyUp=e=>injectKey("keyup",e);
  const onBlur=()=>clearPressed("blur");
  const onVis=()=>{ if(docRef&&docRef.hidden) clearPressed("hidden"); };
  function attach(d){
    if(attached) return;
    docRef=d||doc||global.document;
    docRef.addEventListener("keydown",onKeyDown);
    docRef.addEventListener("keyup",onKeyUp);
    (docRef.defaultView||global).addEventListener("blur",onBlur);
    docRef.addEventListener("visibilitychange",onVis);
    attached=true;
  }
  function detach(){
    if(!attached) return;
    docRef.removeEventListener("keydown",onKeyDown);
    docRef.removeEventListener("keyup",onKeyUp);
    (docRef.defaultView||global).removeEventListener("blur",onBlur);
    docRef.removeEventListener("visibilitychange",onVis);
    attached=false;
  }

  return {
    attach, detach,
    getBindings, setBindings, clearBinding, resetBindings, bindingsSig,
    beginCapture, cancelCapture, isCapturing,
    setActiveSurface, getActiveSurface,
    setRefractory(ms){ refractoryMs=Math.max(0,ms|0); },
    getRefractory(){ return refractoryMs; },
    getBounceCount(){ return bounceCount; },
    clearPressed,
    injectKey, press
  };
}

global.PraxisInput={create, defaultBindings, keyLabel, effCode, isTextTarget,
  RESERVED, HAND_ACTION, version:"0.1.0"};
})(typeof window!=="undefined"?window:globalThis);
