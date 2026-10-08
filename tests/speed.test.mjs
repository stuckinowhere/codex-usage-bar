import test from 'node:test';
import assert from 'node:assert/strict';
import * as speedModule from '../src/speed.mjs';
import {observeMetric,readSpeed,subscribeSpeed} from '../src/speed.mjs';
const turns=new Map();
const emit=(host,thread,method,params,now)=>{
  const key=JSON.stringify([host,thread]);
  if(method==='turn/started')turns.set(key,params.turn?.id);
  observeMetric(host,method,{threadId:thread,turnId:turns.get(key),...params},now);
};
function sample(host,thread,turn,output,total,start,seconds,complete=true){
  emit(host,thread,'turn/started',{turn:{id:turn}},start);
  emit(host,thread,'thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:output},total:{outputTokens:total}}},start+seconds*1000);
  if(complete)emit(host,thread,'turn/completed',{turn:{id:turn}},start+seconds*1000+10);
}
const tool=(host,method,id,now)=>emit(host,'thread',method,{turnId:'a',item:{id,type:'commandExecution'}},now);

test('last response is primary and weighted history remains secondary',()=>{
  sample('weighted','thread','a',130,130,1000,2.1);sample('weighted','thread','b',190,320,100000,4.3,false);
  assert.equal(readSpeed('weighted','thread'),44);
  assert.equal(speedModule.readSpeedDetails('weighted','thread').average,50);
  emit('weighted','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:190},total:{outputTokens:320}}},110000);
  assert.equal(readSpeed('weighted','thread'),44);
  assert.equal(speedModule.readSpeedDetails('weighted','thread').average,50);
});
test('prefill and first-token wait are included: 109 tokens in 5 seconds is 22, not 109',()=>{
  emit('prefill','thread','turn/started',{turn:{id:'a'}},0);
  emit('prefill','thread','item/agentMessage/delta',{turnId:'a',delta:'x'},4000);
  emit('prefill','thread','item/agentMessage/delta',{turnId:'a',delta:'x'},5000);
  emit('prefill','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:109},total:{outputTokens:109}}},5000);
  assert.equal(readSpeed('prefill','thread'),22);
});
test('parallel tool intervals are subtracted once and old-turn tools ignored',()=>{
  emit('tools','thread','turn/started',{turn:{id:'a'}},0);
  tool('tools','item/started','one',1000);tool('tools','item/started','two',2000);
  tool('tools','item/completed','one',5000);tool('tools','item/completed','two',6000);
  emit('tools','thread','item/started',{turnId:'old',item:{id:'wrong',type:'commandExecution'}},7000);
  emit('tools','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:110},total:{outputTokens:110}}},10000);
  assert.equal(readSpeed('tools','thread'),22);
});
test('mid-turn attach, late usage, and overlapping tool usage never invent speed',()=>{
  emit('missing','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:100}}},3000);
  assert.equal(readSpeed('missing','thread'),null);
  emit('missing','thread','turn/started',{turn:{id:'a'}},4000);
  tool('missing','item/started','one',4500);
  emit('missing','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:200},total:{outputTokens:300}}},6000);
  assert.equal(readSpeed('missing','thread'),null);
  emit('missing','thread','turn/completed',{turn:{id:'a'}},6500);
  emit('missing','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:400}}},7000);
  assert.equal(readSpeed('missing','thread'),null);
});
test('host/chat isolation, account clearing, subscriptions and ten-response limit',()=>{
  sample('host-a','same','a',100,100,0,1,false);sample('host-b','same','a',300,300,0,1,false);
  assert.equal(readSpeed('host-a','same'),100);assert.equal(readSpeed('host-b','same'),300);
  let calls=0;const stop=subscribeSpeed('host-a','same',()=>calls++);observeMetric('host-a','account/updated',{},2000);
  assert.equal(readSpeed('host-a','same'),null);assert.equal(calls,1);assert.equal(readSpeed('host-b','same'),300);stop();
  for(let n=0;n<11;n++)sample('ten','thread',String(n),n===0?1000:10,1000+n*10,n*10000,1,n<10);
  assert.equal(readSpeed('ten','thread'),10);
  assert.equal(speedModule.readSpeedDetails('ten','thread').average,10);
  assert.equal(speedModule.readSpeedDetails('ten','thread').sampleCount,10);
});
test('counter reset clears incomparable samples',()=>{
  sample('reset','thread','a',100,2000,0,1,false);
  emit('reset','thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:10},total:{outputTokens:10}}},2000);
  assert.equal(readSpeed('reset','thread'),null);
});

for(const status of ['completed','failed','interrupted'])test(`${status} turns clear speed immediately and late usage cannot revive it`,()=>{
  const host=`terminal-${status}`;
  sample(host,'thread','a',100,100,0,1,false);
  const values=[],stop=subscribeSpeed(host,'thread',()=>values.push(readSpeed(host,'thread')));
  emit(host,'thread','turn/completed',{turn:{id:'a',status}},1100);
  assert.equal(readSpeed(host,'thread'),null);
  assert.deepEqual(values,[null]);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:50},total:{outputTokens:150}}},2000);
  emit(host,'thread','turn/completed',{turn:{id:'a',status}},2100);
  assert.equal(readSpeed(host,'thread'),null);
  assert.deepEqual(values,[null]);
  stop();
});

test('a new turn waits for a fresh valid sample while retaining weighted history',()=>{
  const host='fresh-turn';
  sample(host,'thread','a',100,100,0,1);
  emit(host,'thread','turn/started',{turn:{id:'b'}},2000);
  assert.equal(readSpeed(host,'thread'),null);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:100}}},2500);
  assert.equal(readSpeed(host,'thread'),null);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:0},total:{outputTokens:150}}},3000);
  assert.equal(readSpeed(host,'thread'),null);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:250}}},5000);
  assert.equal(readSpeed(host,'thread'),50);
});

test('a distinct turn clears stale speed without completion and ignores older completions',()=>{
  const host='replaced-turn';
  sample(host,'thread','a',100,100,0,1,false);
  const values=[],stop=subscribeSpeed(host,'thread',()=>values.push(readSpeed(host,'thread')));
  emit(host,'thread','turn/started',{turn:{id:'b'}},2000);
  assert.equal(readSpeed(host,'thread'),null);
  emit(host,'thread','turn/completed',{turn:{id:'a'}},2100);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:50},total:{outputTokens:150}}},2200);
  assert.equal(readSpeed(host,'thread'),null);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:200},total:{outputTokens:350}}},3200);
  assert.equal(readSpeed(host,'thread'),200);
  emit(host,'thread','turn/completed',{turn:{id:'a'}},3300);
  emit(host,'thread','turn/started',{turn:{id:'b'}},3400);
  assert.equal(readSpeed(host,'thread'),200);
  emit(host,'thread','turn/completed',{turn:{id:'b'}},3500);
  assert.deepEqual(values,[null,200,null]);
  stop();
});

test('completion clears only its host and conversation',()=>{
  sample('isolation','first','a',100,100,0,1,false);
  sample('isolation','second','a',200,200,0,1,false);
  sample('another-host','first','a',300,300,0,1,false);
  emit('isolation','first','turn/completed',{turn:{id:'a'}},1100);
  assert.equal(readSpeed('isolation','first'),null);
  assert.equal(readSpeed('isolation','second'),200);
  assert.equal(readSpeed('another-host','first'),300);
});

test('idle thread status clears speed but active status cannot invent turn timing',()=>{
  const host='runtime-status';
  sample(host,'thread','a',100,100,0,1,false);
  const values=[],stop=subscribeSpeed(host,'thread',()=>values.push(readSpeed(host,'thread')));
  emit(host,'thread','thread/status/changed',{status:{type:'active'}},1050);
  assert.equal(readSpeed(host,'thread'),100);
  emit(host,'thread','thread/status/changed',{status:{type:'idle'}},1100);
  assert.equal(readSpeed(host,'thread'),null);
  assert.deepEqual(values,[null]);
  emit(host,'thread','thread/status/changed',{status:{type:'active'}},2000);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:200}}},3000);
  assert.equal(readSpeed(host,'thread'),null);
  assert.deepEqual(values,[null]);
  emit(host,'thread','turn/started',{turn:{id:'b'}},4000);
  emit(host,'thread','thread/tokenUsage/updated',{tokenUsage:{last:{outputTokens:100},total:{outputTokens:300}}},5000);
  assert.equal(readSpeed(host,'thread'),100);
  assert.deepEqual(values,[null,100]);
  stop();
});

// Each case guards a real failure: stale turn attribution, unknown timing,
// cumulative counter gaps, duplicate tool starts, or stale UI presentation.
const usage=(output,total,reasoning)=>({tokenUsage:{last:{outputTokens:output,reasoningOutputTokens:reasoning},total:{outputTokens:total}}});
test('late usage from an older turn is ignored, including its counter',()=>{
  sample('late','t','a',100,100,0,1);
  emit('late','t','turn/started',{turn:{id:'b'}},2000);
  emit('late','t','thread/tokenUsage/updated',{...usage(200,300,50),turnId:'a'},2500);
  assert.equal(readSpeed('late','t'),null);
  emit('late','t','thread/tokenUsage/updated',usage(100,200,20),4000);
  assert.equal(readSpeed('late','t'),50);
});
test('counter gaps discard the sample and re-establish the next boundary',()=>{
  sample('gap','t','a',100,100,0,1,false);
  emit('gap','t','thread/tokenUsage/updated',usage(50,300,10),2000);
  assert.equal(readSpeed('gap','t'),null);
  emit('gap','t','thread/tokenUsage/updated',usage(100,400,20),4000);
  assert.equal(readSpeed('gap','t'),50);
});
test('reasoning is separated without calling non-reasoning output visible text',()=>{
  emit('reasoning','t','turn/started',{turn:{id:'a'}},0);
  emit('reasoning','t','thread/tokenUsage/updated',usage(100,100,60),2000);
  const detail=speedModule.readSpeedDetails('reasoning','t');
  assert.deepEqual({rate:detail.rate,nonReasoningRate:detail.nonReasoningRate,reasoningRate:detail.reasoningRate,seconds:detail.seconds,observedAt:detail.observedAt},
    {rate:50,nonReasoningRate:20,reasoningRate:30,seconds:2,observedAt:2000});
  const view=speedModule.speedPresentation(detail,7000);
  assert.equal(view.value,'~50');assert.equal(view.age,'5s ago');
  assert.match(view.title,/Non-reasoning: ~20/);assert.match(view.title,/Last response/);
});
test('missing or inconsistent reasoning stays unknown without inventing a split',()=>{
  for(const [host,reasoning] of [['absent',undefined],['impossible',101]]){
    emit(host,'t','turn/started',{turn:{id:'a'}},0);
    emit(host,'t','thread/tokenUsage/updated',usage(100,100,reasoning),1000);
    const detail=speedModule.readSpeedDetails(host,'t');
    assert.equal(detail.rate,100);assert.equal(detail.nonReasoningRate,null);assert.equal(detail.reasoningRate,null);
  }
});
test('same rounded rate still publishes a fresh timestamp and stable snapshots',()=>{
  sample('refresh','t','a',100,100,0,1,false);
  const first=speedModule.readSpeedDetails('refresh','t');
  assert.equal(speedModule.readSpeedDetails('refresh','t'),first);
  let notifications=0;const stop=subscribeSpeed('refresh','t',()=>notifications++);
  emit('refresh','t','thread/tokenUsage/updated',usage(100,200,20),2000);
  assert.equal(notifications,1);assert.notEqual(speedModule.readSpeedDetails('refresh','t'),first);
  assert.equal(speedModule.readSpeedDetails('refresh','t').observedAt,2000);stop();
});
test('a sample expires after 60 seconds instead of looking live indefinitely',()=>{
  sample('age','t','a',100,100,0,1,false);
  const detail=speedModule.readSpeedDetails('age','t');
  assert.equal(speedModule.speedPresentation(detail,60999).value,'~100');
  const expired=speedModule.speedPresentation(detail,61000);
  assert.equal(expired.value,'—');assert.equal(expired.age,'stale');assert.match(expired.title,/60s ago/);
});
test('waiting for input or approval invalidates timing until a fresh boundary',()=>{
  for(const flag of ['waitingOnApproval','waitingOnUserInput']){
    sample(flag,'t','a',100,100,0,1,false);
    emit(flag,'t','thread/status/changed',{status:{type:'active',activeFlags:[flag]}},1500);
    assert.equal(readSpeed(flag,'t'),null);
    emit(flag,'t','thread/status/changed',{status:{type:'active',activeFlags:[]}},10000);
    emit(flag,'t','thread/tokenUsage/updated',usage(100,200,20),11000);
    assert.equal(readSpeed(flag,'t'),null);
    emit(flag,'t','thread/tokenUsage/updated',usage(100,300,20),13000);
    assert.equal(readSpeed(flag,'t'),50);
  }
});
test('disconnect or system error clears timing and history until a new observed turn',()=>{
  for(const type of ['notLoaded','systemError']){
    sample(type,'t','a',100,100,0,1,false);
    emit(type,'t','thread/status/changed',{status:{type}},1500);
    assert.equal(readSpeed(type,'t'),null);
    emit(type,'t','thread/status/changed',{status:{type:'active',activeFlags:[]}},2000);
    emit(type,'t','thread/tokenUsage/updated',usage(100,200,20),3000);
    assert.equal(readSpeed(type,'t'),null);
    sample(type,'t','b',100,300,4000,2,false);
    assert.equal(speedModule.readSpeedDetails(type,'t').average,50);
  }
});
test('duplicate tool starts do not change the blocked interval',()=>{
  emit('duplicate-tool','thread','turn/started',{turn:{id:'a'}},0);
  tool('duplicate-tool','item/started','one',1000);tool('duplicate-tool','item/started','one',3000);
  tool('duplicate-tool','item/completed','one',6000);
  emit('duplicate-tool','thread','thread/tokenUsage/updated',usage(100,100,20),10000);
  assert.equal(readSpeed('duplicate-tool','thread'),20);
});
test('tool completion without its start cannot establish a trusted duration',()=>{
  sample('incomplete-tool','thread','a',100,100,0,1,false);
  tool('incomplete-tool','item/completed','unknown',1500);
  emit('incomplete-tool','thread','thread/tokenUsage/updated',usage(100,200,20),2000);
  assert.equal(readSpeed('incomplete-tool','thread'),null);
  emit('incomplete-tool','thread','thread/tokenUsage/updated',usage(100,300,20),4000);
  assert.equal(readSpeed('incomplete-tool','thread'),50);
});
test('missing turn identity and invalid timing cannot retain an old speed',()=>{
  sample('invalid','t','a',100,100,0,1,false);
  observeMetric('invalid','thread/tokenUsage/updated',{threadId:'t',...usage(100,200,20)},2000);
  assert.equal(readSpeed('invalid','t'),null);
  emit('invalid','t','thread/tokenUsage/updated',usage(100,300,20),3000);
  assert.equal(readSpeed('invalid','t'),100);
  emit('invalid','t','thread/tokenUsage/updated',usage(100,400,20),2500);
  assert.equal(readSpeed('invalid','t'),null);
});
test('thread reattachment clears previously measured speed',()=>{
  sample('reattach','t','a',100,100,0,1,false);
  observeMetric('reattach','thread/started',{thread:{id:'t'}},1500);
  assert.equal(readSpeed('reattach','t'),null);
  emit('reattach','t','thread/tokenUsage/updated',usage(100,200,20),2000);
  assert.equal(readSpeed('reattach','t'),null);
});

test('malformed token counts clear a previous sample',()=>{
  for(const value of [NaN,Infinity,null,-1,1.5]){
    const host=`bad-count-${String(value)}`;
    sample(host,'t','a',100,100,0,1,false);
    emit(host,'t','thread/tokenUsage/updated',usage(value,200,20),2000);
    assert.equal(readSpeed(host,'t'),null);
  }
});
test('sub-250ms intervals are discarded and the next complete interval can recover',()=>{
  emit('short','t','turn/started',{turn:{id:'a'}},0);
  emit('short','t','thread/tokenUsage/updated',usage(10,10,0),100);
  assert.equal(readSpeed('short','t'),null);
  emit('short','t','thread/tokenUsage/updated',usage(50,60,10),350);
  assert.equal(readSpeed('short','t'),200);
});
