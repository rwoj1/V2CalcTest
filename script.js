
/* eslint-disable no-unused-vars */
"use strict";

/**
 * Deprescribing Taper Planner (refactor1)
 * - Implements clarified rules from user conversation on 2025-09-01 (AEST).
 * - Supports: BZRA, PPI, Opioid SR tablets, Fentanyl/Buprenorphine patches, Pregabalin, Gabapentin.
 * - Clean data layer + allocation/rounding engines with class-specific rules.
 *
 * IDs expected in DOM (from index.html):
 *   classSelect, medicineSelect, formSelect,
 *   startDate, reviewDate,
 *   addDoseLineBtn, doseLinesContainer,
 *   bestPracticeBox,
 *   p1Percent, p1Interval, p2StartDate, p2Percent, p2Interval,
 *   generateBtn, printBtn, savePdfBtn, resetBtn,
 *   outputCard, hdrMedicine, hdrSpecial, scheduleBlock, patchBlock, classFooter, phaseBanner
 */

// ------------------------------- Utilities ---------------------------------

const $ = (id) => document.getElementById(id);
const todayISO = () => new Date().toISOString().slice(0,10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a,b) => new Date(a).toDateString() === new Date(b).toDateString();
const toAus = (d) => new Date(d).toLocaleDateString("en-AU", { year:"numeric", month:"short", day:"numeric" });
const clamp   = (n, a, b) => Math.max(a, Math.min(b, n));
const EPS = 1e-9;
const THREE_MONTHS_MS = 90*24*3600*1000;

// Small number→words for whole tablets in instructions
const smallIntToWords = (n) => ({
  0:"0",1:"one",2:"two",3:"three",4:"four",5:"five",6:"six",7:"seven",8:"eight",9:"nine",10:"ten"
}[n] ?? String(n));

// Fraction phrasing for tablets (digits in schedule, words in instructions)
function quartersToWords(q){
  const tabs = q/4;
  const whole = Math.floor(tabs + EPS);
  const frac = +(tabs - whole).toFixed(2);
  if (frac === 0) return whole === 1 ? "one tablet" : `${smallIntToWords(whole)} tablets`;
  if (frac === 0.25) return whole ? `${smallIntToWords(whole)} and a quarter tablets` : "a quarter of a tablet";
  if (frac === 0.5)  return whole ? `${smallIntToWords(whole)} and a half tablets` : "half a tablet";
  if (frac === 0.75) return whole ? `${smallIntToWords(whole)} and three quarters tablets` : "three quarters of a tablet";
  return `${tabs} tablets`;
}
function quartersToCell(q){
  const tabs = q/4;
  const whole = Math.floor(tabs + EPS);
  const frac = +(tabs - whole).toFixed(2);
  if (frac === 0) return String(whole);
  if (frac === 0.25) return whole ? `${whole} + ¼` : "¼";
  if (frac === 0.5)  return whole ? `${whole} + ½` : "½";
  if (frac === 0.75) return whole ? `${whole} + ¾` : "¾";
  return String(tabs);
}

// -------------------------------- Data -------------------------------------

// Feature flags
const FEATURES = {
  antipsychoticsEnabled: false,
  allowQuartersByClass: { // class-level quarters toggle (user: keep OFF for now)
    bzra: false
  }
};

// Catalogue: commercial-strength-only (AU); capsules/tabs can be co-combined when allowed
const CATALOGUE = {
  bzra: {
    label: "BZRA",
    allowHalves: true,
    // quarters at class-level via FEATURES.allowQuartersByClass.bzra
    frequencies: ["ONCE_NIGHT"], // Night-only
    medicines: [
      { key:"alprazolam", name:"Alprazolam", strengths:[0.25, 0.5, 1, 2] },
      { key:"clonazepam", name:"Clonazepam", strengths:[0.25, 0.5, 1, 2] },
      { key:"diazepam",   name:"Diazepam", strengths:[2, 5, 10] },
      { key:"flunitrazepam", name:"Flunitrazepam", strengths:[0.5, 1] },
      { key:"lorazepam",  name:"Lorazepam", strengths:[0.5, 1, 2] },
      { key:"nitrazepam", name:"Nitrazepam", strengths:[5] }, // min listed often 2.5–5; conservative
      { key:"oxazepam",   name:"Oxazepam", strengths:[7.5, 15, 30] },
      { key:"temazepam",  name:"Temazepam", strengths:[10, 20] },
      { key:"zolpidem_cr",name:"Zolpidem CR", strengths:[6.25, 12.5], allowHalves:false, forceWhole:true }, // whole only
      { key:"zopiclone",  name:"Zopiclone", strengths:[7.5, 3.75], note:"3.75 available" }
    ]
  },
  ppi: {
    label:"PPI",
    allowHalves:false, // capsules/DR tabs: whole
    frequencies:["OD","BID"],
    medicines:[
      { key:"esomeprazole", name:"Esomeprazole", strengths:[20, 40] },
      { key:"omeprazole",   name:"Omeprazole", strengths:[10, 20] },
      { key:"lansoprazole", name:"Lansoprazole", strengths:[15, 30] },
      { key:"pantoprazole", name:"Pantoprazole", strengths:[20, 40] },
      { key:"rabeprazole",  name:"Rabeprazole", strengths:[10, 20] }
    ]
  },
  opioid_sr: {
    label:"Opioid SR",
    allowHalves:false,
    frequencies:["BID","TID","QID"],
    medicines:[
      // placeholder examples — strengths are class-governed; real product lists can be slotted here
      { key:"morphine_sr", name:"Morphine SR", strengths:[10, 30, 60, 100] },
      { key:"oxycodone_sr", name:"Oxycodone SR", strengths:[10, 20, 40, 80] },
      { key:"hydromorphone_sr", name:"Hydromorphone SR", strengths:[8, 16, 24] }
    ]
  },
  patch_fentanyl: {
    label:"Fentanyl patch",
    isPatch:true,
    patchIntervalDays:3,
    maxConcurrentPatches:3, // per user: ≤3
    strengths:[12.5, 25, 37.5, 50, 62.5, 75, 100], // internal math in 12.5; display as 12 (UI wording handles)
  },
  patch_buprenorphine: {
    label:"Buprenorphine patch",
    isPatch:true,
    patchIntervalDays:7,
    maxConcurrentPatches:3,
    strengths:[5, 10, 20] // mcg/hr
  },
  pregabalin: {
    label:"Pregabalin",
    allowHalves:false,
    frequencies:["BID","TID","QID"], // UI: same options as opioids per user
    medicines:[
      { key:"pregabalin", name:"Pregabalin", strengths:[25, 75, 150, 300] } // no 50 mg
    ],
    reduceOrder:"DIN>MID>AM/PM" // mirrors opioid order
  },
  gabapentin: {
    label:"Gabapentin",
    allowHalves:false,
    frequencies:["BID","TID","QID"],
    medicines:[
      { key:"gabapentin", name:"Gabapentin", strengths:[100, 300, 400, 600, 800] }
    ],
    reduceOrder:"custom" // special rules below
  }
};

// Class-level reduction orders for time-of-day
const REDUCE_ORDERS = {
  opioid_sr: ["DIN","MID","AMPM"], // then balance AM/PM (AM < PM if not equal)
  ppi:       ["MID","PM","AM","DIN"],
  bzra:      ["NIGHT"],
  pregabalin:["DIN","MID","AMPM"],
  gabapentin:["GABA_RULE"] // defined in logic
};

// -------------------------- State & Date Pickers ----------------------------

let state = {
  dirty:true,
  classKey:"",
  medKey:"",
  form:"",
  doseLines:[], // { timeOfDay:"AM|MID|PM|DIN|NIGHT", strength: number (mg or mcg/hr), unit:"tablet|capsule|patch", quartersPerDose: integer(= 4 * tablets), countPerDose: number for whole-unit classes, perDay: 1..4 }
  phases: {
    p1:{ percent:null, intervalDays:null },
    p2:{ start:null, percent:null, intervalDays:null }
  },
  startDate:null,
  reviewDate:null
};

// Init date pickers
(function initDates(){
  const fp = window.flatpickr || function(el, opts){ return { } };
  fp($("#startDate"), { dateFormat:"Y-m-d", defaultDate: todayISO() });
  fp($("#reviewDate"), { dateFormat:"Y-m-d" });
  fp($("#p2StartDate"), { dateFormat:"Y-m-d" });
})();

// ------------------------------ UI Bindings --------------------------------

function setDirty(v=true){
  state.dirty = v;
  $("#printBtn").disabled = v;
  $("#savePdfBtn").disabled = v;
}
function maybeEnableGenerate(){
  const p = +($("#p1Percent").value || 0);
  const i = +($("#p1Interval").value || 0);
  $("#generateBtn").disabled = !(p>0 && i>0 && state.classKey && state.medKey && state.startDate);
}
function resetAll(){
  state = { dirty:true, classKey:"", medKey:"", form:"", doseLines:[], phases:{p1:{},p2:{}}, startDate:null, reviewDate:null };
  document.querySelectorAll("input, select").forEach(el=>{ if(el.id!=="classSelect") el.value=""; });
  $("#medicineSelect").innerHTML = '<option value="">Select class first</option>'; $("#medicineSelect").disabled = true;
  $("#formSelect").innerHTML = '<option value="">Select medicine</option>'; $("#formSelect").disabled = true;
  $("#doseLinesContainer").innerHTML = "";
  $("#phaseBanner").style.display = "none";
  $("#outputCard").style.display = "none";
  $("#hdrSpecial").textContent = "";
  setDirty(true); maybeEnableGenerate();
}

$("#classSelect").addEventListener("change", (e)=>{
  const val = e.target.value;
  state.classKey = val; state.medKey = ""; state.form = "";
  setDirty(true);

  // Populate medicines per class
  const medSel = $("#medicineSelect");
  medSel.disabled = false;
  medSel.innerHTML = '<option value="">Select...</option>';
  if(!val){ medSel.disabled = true; medSel.innerHTML = '<option value="">Select class first</option>'; return; }

  const cat = CATALOGUE[val];
  if(!cat){ medSel.disabled = true; return; }

  const meds = cat.medicines || [{key:val, name:cat.label}];
  meds.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m.key; opt.textContent = m.name;
    medSel.appendChild(opt);
  });

  // Forms/Frequency
  const formSel = $("#formSelect");
  formSel.disabled = false;
  formSel.innerHTML = '<option value="">Select...</option>';
  if(cat.isPatch){
    const opt = document.createElement("option");
    opt.value = `EVERY_${cat.patchIntervalDays}_DAYS`; opt.textContent = `Every ${cat.patchIntervalDays} days (fixed)`;
    formSel.appendChild(opt);
  }else{
    (cat.frequencies || []).forEach(f=>{
      const opt = document.createElement("option");
      opt.value = f; opt.textContent = f.replace("ONCE_NIGHT","Night only");
      formSel.appendChild(opt);
    });
  }

  $("#doseLinesContainer").innerHTML = "";
  maybeEnableGenerate();
});

$("#medicineSelect").addEventListener("change", (e)=>{
  state.medKey = e.target.value;
  setDirty(true);
  maybeEnableGenerate();
});

$("#formSelect").addEventListener("change", (e)=>{
  state.form = e.target.value;
  // Enforce fixed interval on patches: disallow anything else
  if(state.classKey === "patch_fentanyl" || state.classKey === "patch_buprenorphine"){
    e.target.value = `EVERY_${CATALOGUE[state.classKey].patchIntervalDays}_DAYS`;
  }
  setDirty(true);
  maybeEnableGenerate();
});

["startDate","reviewDate","p2StartDate","p1Percent","p1Interval","p2Percent","p2Interval"].forEach(id=>{
  $(id).addEventListener("input", ()=>{
    if(id==="startDate") state.startDate = $("#startDate").value || null;
    if(id==="reviewDate") state.reviewDate = $("#reviewDate").value || null;
    if(id==="p2StartDate") state.phases.p2.start = $("#p2StartDate").value || null;
    if(id==="p1Percent") state.phases.p1.percent = +($("#p1Percent").value || 0);
    if(id==="p1Interval") state.phases.p1.intervalDays = +($("#p1Interval").value || 0);
    if(id==="p2Percent") state.phases.p2.percent = +($("#p2Percent").value || 0);
    if(id==="p2Interval") state.phases.p2.intervalDays = +($("#p2Interval").value || 0);
    setDirty(true); maybeEnableGenerate();
  });
});

$("#resetBtn").addEventListener("click", resetAll);

// ---------------------------- Dose Line Editor ------------------------------

const TIMES = ["AM","MID","PM","DIN","NIGHT"];
function addDoseLine(prefTime="NIGHT"){
  const classKey = state.classKey;
  const cat = CATALOGUE[classKey];
  const container = $("#doseLinesContainer");

  const row = document.createElement("div");
  row.className = "dose-line";

  // Time of day
  const selTime = document.createElement("select");
  TIMES.forEach(t=>{
    if(classKey==="bzra" && t!=="NIGHT") return; // BZRA night-only
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    if(t===prefTime) opt.selected = true;
    selTime.appendChild(opt);
  });

  // Strength
  const selStr = document.createElement("select");
  const med = (cat.medicines||[]).find(m=>m.key===state.medKey);
  const strengths = cat.isPatch ? cat.strengths : (med?.strengths || []);
  strengths.forEach(s=>{
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s + (cat.isPatch ? " mcg/hr" : " mg");
    selStr.appendChild(opt);
  });

  // Number per dose (tablets/capsules or patches)
  const inpCount = document.createElement("input");
  inpCount.type = "number"; inpCount.min = "0"; inpCount.step = "1"; inpCount.value = "1";

  // Frequency per day
  const selFreq = document.createElement("select");
  const freqOpts = classKey==="bzra" ? ["ONCE"] : ["OD","BID","TID","QID"];
  freqOpts.forEach(f=>{
    const opt = document.createElement("option");
    opt.value = f; opt.textContent = ({ONCE:"Once",OD:"Once daily",BID:"Twice daily",TID:"Three times daily",QID:"Four times daily"})[f];
    selFreq.appendChild(opt);
  });
  if(classKey==="bzra") selFreq.value = "ONCE";

  // Remove button
  const btnRem = document.createElement("button");
  btnRem.className = "remove"; btnRem.textContent = "Remove";
  btnRem.addEventListener("click", ()=>{ row.remove(); setDirty(true); });

  // Assemble
  row.appendChild(selTime);
  row.appendChild(selStr);
  row.appendChild(inpCount);
  row.appendChild(selFreq);
  row.appendChild(btnRem);
  container.appendChild(row);
  setDirty(true);
}

$("#addDoseLineBtn").addEventListener("click", ()=> addDoseLine(state.classKey==="bzra" ? "NIGHT" : "AM"));

// --------------------------- Validation helpers -----------------------------

function inlineHint(el, msg){
  const banner = $("#phaseBanner");
  banner.textContent = msg || "";
  banner.style.display = msg ? "block" : "none";
}

function validatePhaseInputs(){
  // Fixed patch intervals enforced at form level; validate P1 required fields
  const p = +($("#p1Percent").value || 0);
  const i = +($("#p1Interval").value || 0);
  const s = $("#startDate").value;
  if(!(p>0 && i>0 && s)) return "Phase 1 requires start date, % and interval.";
  return "";
}

// ----------------------- Rounding & Allocation Engine -----------------------

function getClassConfig(){
  const classKey = state.classKey;
  const cat = CATALOGUE[classKey];
  const med = (cat.medicines||[]).find(m=>m.key===state.medKey) || null;
  const allowHalves = !!cat.allowHalves && !(med && med.forceWhole);
  const allowQuarters = FEATURES.allowQuartersByClass[classKey] && !med?.forceWhole;
  return { classKey, cat, med, allowHalves, allowQuarters };
}

// Build internal regimen model from UI rows
function captureRegimen(){
  const rows = [...document.querySelectorAll(".dose-line")];
  const { classKey, cat } = getClassConfig();
  const isPatch = !!cat.isPatch;
  const reg = [];
  for(const r of rows){
    const [timeSel, strSel, countInp, freqSel] = r.querySelectorAll("select, input");
    const timeOfDay = timeSel.value;
    const strength = parseFloat(strSel.value);
    const count = +countInp.value || 0;
    const freq = freqSel.value;
    if(count<=0 || !strength) continue;
    reg.push({ timeOfDay, strength, count, freq, unit: isPatch? "patch" : "unit" });
  }
  return reg;
}

// Compute target dates (cap by review date OR 3 months — review takes precedence on same day)
function computeEndDate(startISO){
  const start = new Date(startISO);
  const cap = new Date(start.getTime() + THREE_MONTHS_MS);
  let end = cap;
  if(state.reviewDate){
    const r = new Date(state.reviewDate);
    if(r.getTime() <= cap.getTime()) end = r; // review before cap
  }
  return end;
}

// Decide the order of reduction for the current class
function getReduceOrder(){
  const key = state.classKey;
  const rule = REDUCE_ORDERS[key];
  return rule || ["AM","MID","PM","DIN","NIGHT"];
}

// Helper: choose next time-of-day to decrement based on class rules
function* timeOfDayIterator(classKey){
  const ord = getReduceOrder();
  if(ord[0]==="AMPM"){ yield "AM"; yield "PM"; }
  else if(ord[0]==="GABA_RULE"){
    // Gabapentin special:
    // - if regimen is TID: reduce equally; if uneven, ensure MID < AM/PM
    // - if QID: reduce DIN first, then behave like TID rule
    yield "DIN";
    yield "MID";
    yield "AM";
    yield "PM";
  } else if(ord[0]==="DIN" && ord[1]==="MID"){
    yield "DIN"; yield "MID"; yield "AM"; yield "PM";
  } else if(ord[0]==="MID" && ord[1]==="PM"){
    yield "MID"; yield "PM"; yield "AM"; yield "DIN";
  } else if(ord[0]==="NIGHT"){
    yield "NIGHT";
  } else {
    for(const t of ["AM","MID","PM","DIN","NIGHT"]) yield t;
  }
}

// Total daily dose (mg or mcg/hr sum where relevant)
function totalDailyDoseMg(reg){
  return reg.reduce((sum, x)=> sum + x.strength * x.count, 0);
}

// Remove one "unit step" from a specific time-of-day, picking highest strength first
function removeOneUnit(reg, timeOfDay, allowHalves, allowQuarters){
  // Find candidate lines at given time
  const lines = reg
    .map((x,idx)=>({...x, idx}))
    .filter(x=>x.timeOfDay===timeOfDay && x.count>0);

  if(!lines.length) return false;

  // Heuristic: remove from highest strength first to minimise unit count
  lines.sort((a,b)=> b.strength - a.strength);

  // For tablets/capsules: only whole units unless halves allowed (quarters by class flag)
  const line = lines[0];
  if(line.unit==="patch"){
    // For patches, remove the smallest possible patch first (to preserve consolidation elsewhere)
    lines.sort((a,b)=> a.strength - b.strength);
  }

  const target = reg[line.idx];
  if(target.unit==="patch"){
    if(target.count > 0){
      target.count -= 1;
      if(target.count < 0) target.count = 0;
      return true;
    }
    return false;
  }else{
    // Whole unit classes (PPIs, opioid SR, gabapentinoids): remove one whole
    if(!allowHalves && !allowQuarters){
      if(target.count>0){ target.count -= 1; return true; }
      return false;
    }
    // BZRA halves/quarters rules (class-level)
    // We'll model counts as integer number of quarters per dose line by temporarily scaling
    // BUT since UI captures whole counts, we only decrement whole units here;
    // fractional tablets are used only when user sets them in UI or future toggle.
    if(target.count>0){ target.count -= 1; return true; }
    return false;
  }
}

// Compute step by percentage with rounding-to-permitted-unit rules
function applyPercentReduction(reg, percent, classKey){
  const { allowHalves, allowQuarters } = getClassConfig();
  const before = totalDailyDoseMg(reg);
  const target = before * (1 - percent/100);

  // Simulate greedy unit removals following class time-of-day order until we reach the nearest permitted total.
  // Tie-breakers: nearest; if equal distance, prefer fewer units; if still equal, round up.
  const clone = JSON.parse(JSON.stringify(reg));
  const minStepMg = (()=>{
    // Minimal decrement is the smallest strength among lines (whole unit), except classes that allow halves => 0.5 * smallest
    const mins = clone.map(x=>x.strength);
    const m = Math.min(...mins);
    let step = m;
    if(allowHalves) step = Math.min(step, m/2);
    if(allowQuarters) step = Math.min(step, m/4);
    return step;
  })();

  const iter = [...timeOfDayIterator(classKey)];
  let idx = 0;
  let after = totalDailyDoseMg(clone);
  let removedUnits = 0;

  // Helper to compute "distance" and "unit penalty"
  const score = (dose, units) => {
    const dist = Math.abs(dose - target);
    return [dist, units, dose]; // later: prefer fewer units; then prefer rounding UP (higher dose)
  };

  let best = { dose: after, units: 0, snapshot: JSON.parse(JSON.stringify(clone)) };
  let bestScore = score(after, 0);

  // Cap iterations to avoid infinite loop
  for(let k=0;k<1000;k++){
    if(after <= 0) break;
    const t = iter[idx % iter.length];
    idx++;

    const changed = removeOneUnit(clone, t, allowHalves, allowQuarters);
    if(!changed) continue;
    removedUnits++;
    after = totalDailyDoseMg(clone);
    const sc = score(after, removedUnits);

    // pick better: smaller distance; if tie, fewer units; if still tie, higher dose (round up)
    if(sc[0] + EPS < bestScore[0] ||
       (Math.abs(sc[0]-bestScore[0])<EPS && (sc[1] < bestScore[1] ||
        (sc[1]===bestScore[1] && sc[2] > bestScore[2])))){
      best = { dose: after, units: removedUnits, snapshot: JSON.parse(JSON.stringify(clone)) };
      bestScore = sc;
    }

    // Stop when we've crossed target and next decrement would be further away
    if(after <= target && Math.abs(after-target) <= minStepMg/2 + EPS) break;
  }

  return best.snapshot;
}

// Patch consolidation & caps (≤3 concurrent)
function consolidatePatches(reg, classKey){
  const cat = CATALOGUE[classKey];
  if(!cat?.isPatch) return reg;
  // Combine identical timeOfDay entries by strength; cap concurrent patches
  const grouped = {};
  for(const x of reg){
    const key = `${x.timeOfDay}|${x.strength}`;
    grouped[key] = (grouped[key]||0) + x.count;
  }
  const out = [];
  const perTime = {};
  for(const key in grouped){
    const [t, s] = key.split("|");
    const strength = +s;
    const count = grouped[key];
    perTime[t] = (perTime[t]||0) + count;
    out.push({ timeOfDay:t, strength, count: Math.min(count, cat.maxConcurrentPatches), unit:"patch" });
  }
  return out;
}

// Build schedule rows between dates according to phases
function buildSchedule(){
  const startISO = $("#startDate").value;
  const endDate = computeEndDate(startISO);
  const { classKey } = getClassConfig();
  const reg0 = captureRegimen();
  if(!reg0.length) throw new Error("Please add at least one dose line.");

  // Snap p2 start if earlier than end of p1
  const p1pct = +($("#p1Percent").value||0);
  const p1int = +($("#p1Interval").value||0);
  const p2pct = +($("#p2Percent").value||0);
  const p2int = +($("#p2Interval").value||0);
  const p2start = $("#p2StartDate").value || null;

  const steps = [];
  let cursor = new Date(startISO);
  const end = endDate;
  let currentReg = JSON.parse(JSON.stringify(reg0));

  // Phase 1
  while(cursor <= end){
    const nextDate = addDays(cursor, p1int);
    const snapshot = JSON.parse(JSON.stringify(currentReg));
    steps.push({ date: cursor, regimen: snapshot });
    // Prepare next
    currentReg = applyPercentReduction(currentReg, p1pct, classKey);
    cursor = nextDate;
    // If Phase 2 begins before nextDate, we'll handle snap below
    if(p2start){
      const p2d = new Date(p2start);
      if(p2d < cursor){ // user set P2 inside current P1 step -> snap forward
        $("#phaseBanner").textContent = `Phase 2 start adjusted to ${toAus(cursor)} to follow Phase 1.`;
        $("#phaseBanner").style.display = "block";
      }
    }
    // Stop if we passed p2 start or end date
    if(p2start && new Date(p2start) <= cursor) break;
    if(cursor > end) break;
  }

  // Phase 2 (if applicable)
  if(p2start){
    let p2cursor = new Date(Math.max(new Date(p2start).getTime(), steps[steps.length-1].date.getTime()+1));
    // Snap to cursor if earlier
    if(p2cursor < cursor) p2cursor = cursor;
    while(p2cursor <= end){
      const snapshot = JSON.parse(JSON.stringify(currentReg));
      steps.push({ date: p2cursor, regimen: snapshot });
      currentReg = applyPercentReduction(currentReg, p2pct, classKey);
      p2cursor = addDays(p2cursor, p2int);
      if(p2cursor > end) break;
    }
  }

  // Add final Stop row on the date where regimen would reduce to 0 or when end reached
  steps.push({ date: end, regimen: currentReg, stop:true });

  // Patch consolidation on each step
  if(CATALOGUE[classKey]?.isPatch){
    steps.forEach(s=> s.regimen = consolidatePatches(s.regimen, classKey));
  }

  return steps;
}

// ------------------------------- Rendering ---------------------------------

function renderSchedule(steps){
  $("#outputCard").style.display = "block";
  $("#scheduleBlock").innerHTML = "";
  $("#patchBlock").style.display = "none";
  $("#hdrMedicine").textContent = buildHeaderTitle();
  $("#classFooter").textContent = buildFooterText();

  const tbl = document.createElement("table");
  tbl.className = "table";
  tbl.innerHTML = `
    <thead>
      <tr><th style="width:140px">Apply on</th><th>Instructions</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = tbl.querySelector("tbody");

  for(const s of steps){
    const tr = document.createElement("tr");
    const tdDate = document.createElement("td");
    const tdInstr = document.createElement("td");
    tdDate.innerHTML = `<div class="bubble">${toAus(s.date)}</div>`;

    if(s.stop){
      tdInstr.innerHTML = `<strong>Stop.</strong>`;
    }else{
      tdInstr.textContent = regimenToInstruction(s.regimen);
    }
    tr.appendChild(tdDate); tr.appendChild(tdInstr);
    tb.appendChild(tr);
  }
  $("#scheduleBlock").appendChild(tbl);
}

function regimenToInstruction(reg){
  const { classKey } = getClassConfig();
  if(CATALOGUE[classKey]?.isPatch){
    // Example: "Apply one 25 mcg/hr patch to upper arm. Remove previous patch."
    const parts = [];
    const byTime = {};
    reg.forEach(x=>{ byTime[x.timeOfDay] = (byTime[x.timeOfDay]||[]).concat(x); });
    for(const t of Object.keys(byTime)){
      const items = byTime[t].map(x=> `${x.count} × ${x.strength}${classKey==="patch_fentanyl" ? "" : ""} mcg/hr patch`);
      parts.push(`${t}: apply ${items.join(" + ")}.`);
    }
    return parts.join(" ");
  }else{
    // Tablets/capsules phrasing per line
    const byTime = {};
    reg.forEach(x=>{ byTime[x.timeOfDay] = (byTime[x.timeOfDay]||[]).concat(x); });
    const lines = [];
    for(const t of Object.keys(byTime)){
      const items = byTime[t].map(x=> `${x.count} × ${x.strength} mg`);
      lines.push(`${t}: take ${items.join(" + ")}.`);
    }
    return lines.join(" ");
  }
}

function buildHeaderTitle(){
  const cls = state.classKey ? CATALOGUE[state.classKey].label : "";
  const med = (()=>{
    const cat = CATALOGUE[state.classKey]; if(!cat) return "";
    const m = (cat.medicines||[]).find(m=>m.key===state.medKey);
    return m?.name || cat.label;
  })();
  return med ? `${med} taper plan` : `${cls} taper plan`;
}

function buildFooterText(){
  const cls = state.classKey || "";
  switch(cls){
    case "bzra": return "Review sleep hygiene and CBT‑I resources. Avoid abrupt cessation.";
    case "ppi": return "Step down to lowest effective dose. Monitor rebound symptoms.";
    case "opioid_sr": return "Monitor analgesia, function, withdrawal, and adverse effects.";
    case "patch_fentanyl": return "Rotate sites. Ensure safe disposal. Keep ≤3 concurrent patches.";
    case "patch_buprenorphine": return "Rotate sites. Ensure safe disposal. Keep ≤3 concurrent patches.";
    case "pregabalin": return "Assess pain control, sedation, dizziness; taper to minimise withdrawal.";
    case "gabapentin": return "Assess pain control and dizziness; taper to minimise withdrawal.";
    default: return "";
  }
}

// ------------------------------- Actions -----------------------------------

$("#generateBtn").addEventListener("click", ()=>{
  const err = validatePhaseInputs();
  if(err){ inlineHint($("#phaseBanner"), err); return; }
  inlineHint($("#phaseBanner"), "");

  try{
    const steps = buildSchedule();
    renderSchedule(steps);
    setDirty(false);
  }catch(e){
    inlineHint($("#phaseBanner"), e.message || String(e));
  }
});

$("#printBtn").addEventListener("click", ()=> window.print());

$("#savePdfBtn").addEventListener("click", ()=>{
  const node = $("#outputCard");
  const opt = {
    margin: [10,10,10,10],
    filename: (buildHeaderTitle() || "taper-plan").toLowerCase().replace(/\s+/g,"-") + ".pdf",
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };
  window.html2pdf().set(opt).from(node).save();
});

// Seed defaults
resetAll();
