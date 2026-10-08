// Renderer-local counts/timing only. No text, credentials or persistent metrics.
const hosts=new Map(),listeners=new Map();
const keyFor=(host,thread)=>JSON.stringify([host,thread]);
const validCount=n=>Number.isSafeInteger(n)&&n>=0;
const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageGeneration','collabAgentToolCall']);
const events=new Set(['turn/started','turn/completed','thread/started','thread/status/changed','thread/tokenUsage/updated','thread/deleted','item/started','item/completed']);
function emit(host,thread){for(const callback of listeners.get(keyFor(host,thread))??[])callback();}
export function subscribeSpeed(host,thread,callback){
  const key=keyFor(host,thread),callbacks=listeners.get(key)??new Set();
  callbacks.add(callback);listeners.set(key,callbacks);
  return()=>{callbacks.delete(callback);if(!callbacks.size)listeners.delete(key);};
}
// The cached object is stable between notifications (useSyncExternalStore).
export function readSpeedDetails(host,thread){return hosts.get(host)?.get(thread)?.detail??null;}
export function readSpeed(host,thread){return readSpeedDetails(host,thread)?.rate??null;}
function publish(host,thread,state,detail=null){
  if(detail!==state.detail){state.detail=detail;emit(host,thread);}
}
function resetSegment(state,now){
  state.started=now;state.paused=0;state.blockedAt=state.tools.size?now:null;
}
function invalidate(host,thread,state){resetSegment(state,null);publish(host,thread,state);}
function elapsed(state,now){
  if(state.started==null)return null;
  return (now-state.started-state.paused-(state.blockedAt==null?0:now-state.blockedAt))/1000;
}
function record(host,thread,state,output,reasoning,seconds,now){
  state.samples.push({output,seconds});state.samples=state.samples.slice(-10);
  const sums=state.samples.reduce((sum,s)=>({output:sum.output+s.output,seconds:sum.seconds+s.seconds}),{output:0,seconds:0});
  const split=validCount(reasoning)&&reasoning<=output;
  publish(host,thread,state,Object.freeze({
    rate:Math.round(output/seconds),average:Math.round(sums.output/sums.seconds),
    nonReasoningRate:split?Math.round((output-reasoning)/seconds):null,
    reasoningRate:split?Math.round(reasoning/seconds):null,
    output,reasoningOutput:split?reasoning:null,seconds,observedAt:now,sampleCount:state.samples.length,
  }));
}
export function observeMetric(host,method,params,now=performance.now()){
  if(typeof host!=='string')return;
  if(method==='account/updated'||method==='account/login/completed'){
    const threads=hosts.get(host);hosts.delete(host);
    for(const thread of threads?.keys()??[])emit(host,thread);
    return;
  }
  const thread=method==='thread/started'?params?.thread?.id:params?.threadId;
  if(typeof thread!=='string'||!events.has(method))return;
  let threads=hosts.get(host);if(!threads){threads=new Map();hosts.set(host,threads);}
  if(method==='thread/deleted'||method==='thread/started'){
    threads.delete(thread);emit(host,thread);return;
  }
  let state=threads.get(thread);
  if(!state){
    state={total:null,turn:null,active:false,waiting:false,started:null,paused:0,blockedAt:null,tools:new Set(),samples:[],detail:null,lastNow:null};
    threads.set(thread,state);
    if(threads.size>256){const oldest=threads.keys().next().value;threads.delete(oldest);emit(host,oldest);}
  }
  // Ignore stale turn-scoped events before touching counters or the clock.
  if((method==='turn/completed'&&params.turn?.id!==state.turn)||
     ((method==='item/started'||method==='item/completed'||method==='thread/tokenUsage/updated')&&
      typeof params.turnId==='string'&&params.turnId!==state.turn&&state.active))return;
  if(!Number.isFinite(now)||(state.lastNow!=null&&now<state.lastNow)){
    invalidate(host,thread,state);return;
  }
  state.lastNow=now;
  if(method==='turn/started'){
    const turn=params.turn?.id;if(typeof turn!=='string'||turn===state.turn)return;
    state.turn=turn;state.active=true;state.waiting=false;state.tools.clear();
    resetSegment(state,now);publish(host,thread,state);return;
  }
  if(method==='turn/completed'||method==='thread/status/changed'){
    const status=params.status;
    if(method==='thread/status/changed'&&status?.type==='active'){
      state.waiting=(status.activeFlags??[]).length>0;
      if(state.waiting)invalidate(host,thread,state);
      return;
    }
    if(method==='thread/status/changed'&&!['idle','notLoaded','systemError'].includes(status?.type))return;
    if(status?.type==='notLoaded'||status?.type==='systemError'){
      state.samples=[];state.total=null;state.turn=null;
    }
    state.active=false;state.waiting=false;state.tools.clear();invalidate(host,thread,state);return;
  }
  if(method==='item/started'||method==='item/completed'){
    const item=params.item;
    if(!state.active||params.turnId!==state.turn||!toolTypes.has(item?.type)||typeof item.id!=='string')return;
    if(method==='item/started'){
      if(state.tools.has(item.id))return;
      if(!state.tools.size)state.blockedAt=now;
      state.tools.add(item.id);
    }else if(!state.tools.delete(item.id)){
      invalidate(host,thread,state);
    }else if(!state.tools.size){
      if(state.blockedAt!=null)state.paused+=now-state.blockedAt;
      state.blockedAt=null;
    }
    return;
  }
  const total=params.tokenUsage?.total?.outputTokens,last=params.tokenUsage?.last?.outputTokens;
  if(!validCount(total)||!validCount(last)){
    state.total=null;invalidate(host,thread,state);return;
  }
  if(typeof params.turnId!=='string'){
    state.total=total;invalidate(host,thread,state);
    resetSegment(state,state.active&&!state.waiting&&!state.tools.size?now:null);return;
  }
  if(total===state.total)return; // Duplicate notice is not another model response.
  const previous=state.total;state.total=total;
  const seconds=elapsed(state,now);
  const consistent=last<=total&&(previous==null||total-previous===last);
  if(previous!=null&&total<previous)state.samples=[];
  // Token counters are response boundaries, not streaming deltas. If a count
  // or timing interval is ambiguous, discard it and establish a new boundary.
  if(state.active&&!state.waiting&&!state.tools.size&&consistent&&last>0&&seconds>=.25&&last/seconds<1e6){
    record(host,thread,state,last,params.tokenUsage.last.reasoningOutputTokens,seconds,now);
  }else publish(host,thread,state);
  resetSegment(state,state.active&&!state.waiting&&!state.tools.size?now:null);
}

export function speedPresentation(detail,now=performance.now()){
  if(!detail)return {value:'—',age:'',title:'Last response unavailable. Waiting for matching token counts and trustworthy timing; idle chats show —.'};
  const seconds=Math.max(0,Math.floor((now-detail.observedAt)/1000));
  const stale=!Number.isFinite(now)||now<detail.observedAt||seconds>=60;
  const split=detail.reasoningOutput==null?'Reasoning breakdown unavailable.':
    `Non-reasoning: ~${detail.nonReasoningRate} token/s (${detail.output-detail.reasoningOutput} tokens); reasoning: ~${detail.reasoningRate} token/s (${detail.reasoningOutput} tokens). Non-reasoning includes tool-call output; it is not a visible-text speed.`;
  return {
    value:stale?'—':`~${detail.rate}`,age:stale?'stale':`${seconds}s ago`,
    title:`Last response: ~${detail.rate} token/s (${detail.output} output tokens / ${detail.seconds.toFixed(2)}s). Updated ${seconds}s ago${stale?'; stale sample hidden':''}. Weighted average (${detail.sampleCount} response${detail.sampleCount===1?'':'s'}): ~${detail.average} token/s. ${split} Desktop timing includes initial waiting and excludes observed tool execution. Provider API timing is unavailable.`,
  };
}
