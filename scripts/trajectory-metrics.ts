export type Scene = 'available'|'occupied';
export type Expected = {requestId:string; assetId:string; channel:string; requiredTime:string; alternative:string};
export type ToolStep = {turn:number; action:string; args?:Record<string,unknown>; result?:Record<string,unknown>};
export type ItemResult = {assetId?:string; channel?:string; requiredTime?:string; status?:string;
  suggestedTime?:string|null; draftId?:string|null; reason?:string|null; stopReason?:string|null; needsConfirmation?:boolean; proposalId?:string|null};
export type DraftRow = {draftId:string; requestId:string; assetId:string; channel:string; time:string};
export type Evidence = {status?:string; requestId?:string; item?:ItemResult; trace:ToolStep[]; drafts:DraftRow[]};

export function scoreTrajectory(scene:Scene, evidence:Evidence, expected:Expected) {
  const {item,drafts,trace,status,requestId} = evidence;
  const events = trace.filter(s=>s.turn>0);
  const observed = events.find(s=>s.action==='query_slots' && s.args?.scope==='requested'
    && s.result?.code===(scene==='available'?'AVAILABLE':'OCCUPIED') && s.result?.time===expected.requiredTime);
  const identity = requestId===expected.requestId && item?.assetId===expected.assetId
    && item?.channel===expected.channel && item?.requiredTime===expected.requiredTime;
  const next = observed && events.find(s=>s.turn>observed.turn && (scene==='available'
    ? s.action==='save_draft' && s.args?.time===expected.requiredTime
    : s.action==='query_slots' && s.args?.scope==='alternatives'));
  const decisionPass = !!(next && (scene==='available'
    || (next.result?.code==='CANDIDATES_FOUND' && Array.isArray(next.result.available)
      && next.result.available.includes(expected.alternative))));
  const businessPass = !!(identity && (scene==='available'
    ? status==='completed' && item?.status==='saved' && item?.needsConfirmation===false
      && item?.suggestedTime===expected.requiredTime && !!item?.draftId
      && drafts.length===1 && drafts[0].draftId===item.draftId && drafts[0].assetId===expected.assetId
      && drafts[0].requestId===expected.requestId && drafts[0].channel===expected.channel && drafts[0].time===expected.requiredTime
    : status==='action_required' && item?.status==='pending_confirmation' && item?.needsConfirmation===true
      && item?.suggestedTime===expected.alternative && item?.draftId===null && drafts.length===0));
  return {businessPass,decisionPass,modelToolCalls:events.length,
    unnecessarySaveCalls:scene==='occupied'?events.filter(s=>s.action==='save_draft').length:0};
}

export type ScoredRun = Pick<Evidence,'item'> & ReturnType<typeof scoreTrajectory> & {
  version:string; repeat:number; scene:Scene; error?:string;
};

export function summarizeTrajectories(versions:{version:string;runtimeSha256:string}[],rows:ScoredRun[],repeats:number){
  const scenes:Scene[]=['available','occupied'];
  const summary=versions.map(version=>({
    ...version,
    scenarios:scenes.map(scene=>{
      const selected=rows.filter(r=>r.version===version.version && r.scene===scene);
      const total=selected.reduce((n,r)=>n+r.modelToolCalls,0);
      return {scene, runs:selected.length,businessPass:selected.filter(r=>r.businessPass).length,
        decisionPass:selected.filter(r=>r.decisionPass).length, cliErrors:selected.filter(r=>r.error).length,
        invalidFinalResponses:selected.filter(r=>r.item?.reason==='INVALID_FINAL_RESPONSE'
          || r.item?.stopReason==='INVALID_FINAL_RESPONSE').length,
        runsWithUnnecessarySave:selected.filter(r=>r.unnecessarySaveCalls>0).length,
        unnecessarySaveCalls:selected.reduce((n,r)=>n+r.unnecessarySaveCalls,0),
        meanModelToolCalls:selected.length?Math.round(total/selected.length*100)/100:null};
    })
  }));
  const pairedPassing=versions.map(({version})=>({
    version,
    runs:repeats,
    passed:Array.from({length:repeats},(_,i)=>i+1).filter(n=>{
      const pair=rows.filter(r=>r.version===version && r.repeat===n);
      return pair.length===scenes.length && scenes.every(scene=>pair.some(r=>r.scene===scene && r.businessPass && r.decisionPass));
    }).length
  }));
  return {summary,pairedPassing};
}
