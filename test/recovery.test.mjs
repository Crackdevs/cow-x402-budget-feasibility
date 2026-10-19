import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,rmdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Journal,BudgetAdapter,DEFAULT_POLICY,SALT,DUMMY_SIGNATURE} from '../adapter.mjs';
import {requirements,transport,URL} from './helpers.mjs';
const dirs=[];const policy={...DEFAULT_POLICY,planCap:'2500000',periodCap:'2500000',maxQuote:'1000'};
const confirm={reason:'Operator confirmed child terminated; retain all authority and abandon this identity',operatorConfirmedStopped:true};
function setup(p=policy){const dir=mkdtempSync(join(tmpdir(),'cow-recovery-'));dirs.push(dir);const path=join(dir,'journal.sqlite');Journal.provision(path,p);return {path,policy:p};}
function adapter(s,extra={}){const records=[];const wire=transport({getRequirements:()=>requirements({amount:'1000'}),...extra.transportOptions});const a=new BudgetAdapter({path:s.path,policy:s.policy,salt:extra.salt??SALT,fakeFetch:wire.fakeFetch,readChannel:async()=>[0n,0n],recordSigner:async(t,c)=>{records.push({typed:t,state:c.journal});return DUMMY_SIGNATURE;},...extra});return {a,records,wire};}
function crash(s,mode='paid-send'){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--import','./network-guard.mjs','test/crash-worker.mjs',s.path,mode,JSON.stringify(s.policy)],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let err='';p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>resolve({code,pid:p.pid,err}));});}
async function retired(s,mode='paid-send'){
 const child=await crash(s,mode);assert.ok([73,74,75,76].includes(child.code),child.err);
 const j=new Journal(s.path,s.policy);const id=Object.keys(j.read().channels)[0];
 assert.throws(()=>j.quarantineChannel(id,confirm),/LOCK_BUSY_OR_STALE/);
 // Test operator has observed this exact child's exit. No other processes use this isolated test path.
 rmdirSync(s.path+'.lock');const before=j.read();const r=j.quarantineChannel(id,confirm);const after=j.read();j.close();return {child,before,after,id,r};
}
function edit(s,fn){const db=new DatabaseSync(s.path);const state=JSON.parse(db.prepare('SELECT body FROM journal').get().body);fn(state);db.prepare('UPDATE journal SET body=?').run(JSON.stringify(state));db.close();}
test.after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true});});

test('01 actual process interruption, explicit quarantine, and useful fresh-channel continuation',async()=>{
 const s=setup();const old=await retired(s);assert.equal(old.before.attempts[0].state,'exposed');assert.equal(old.after.attempts[0].state,'exposed');assert.deepEqual(old.after.reservations,old.before.reservations);assert.deepEqual(old.after.attempts,old.before.attempts);assert.equal(old.after.channels[old.id].high,'1000');
 const next=adapter(s,{salt:old.r.freshSalt});await next.a.fetch(URL);await next.a.fetch(URL);assert.equal(next.wire.received[0].payload.type,'deposit');assert.equal(next.wire.received[1].payload.type,'voucher');assert.equal(next.records.length,3);assert.equal(next.a.journal.totals().plan,'2000000');
 const state=next.a.journal.read();assert.equal(state.channels[old.id].lifecycle,'quarantined');assert.equal(state.channels[old.id].high,'1000');assert.equal(Object.values(state.channels).find(c=>c.lifecycle==='open').high,'2000');assert.notEqual(next.wire.received[0].payload.voucher.channelId,old.id);
 writeFileSync('evidence/continued-after-crash.json',JSON.stringify({crashExit:old.child.code,oldAttemptState:state.attempts[0].state,oldHigh:state.channels[old.id].high,quarantinedChannel:old.id,newChannel:next.wire.received[0].payload.voucher.channelId,newPayloadTypes:next.wire.received.map(p=>p.payload.type),gross:next.a.journal.totals(),retainedReservationCount:state.reservations.length},null,2));next.a.close();
});
test('02 fresh identity cannot exceed original 1.5-USDC gross cap',async()=>{
 const s=setup({...policy,planCap:'1500000',periodCap:'1500000'});const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt});await assert.rejects(next.a.fetch(URL),/PLAN_CAP/);assert.equal(next.records.length,0);assert.equal(next.a.journal.totals().plan,'1000000');next.a.close();
});
test('03 four real abrupt-exit boundaries retain authority across explicit quarantine',async t=>{
 for(const mode of ['first-signer','voucher-signer','paid-send','receipt-update'])await t.test(mode,async()=>{const s=setup();const old=await retired(s,mode);const next=adapter(s,{salt:old.r.freshSalt});await next.a.fetch(URL);const state=next.a.journal.read();assert.deepEqual(state.attempts[0],old.before.attempts[0]);assert.equal(next.a.journal.totals().plan,'2000000');assert.ok(state.attempts[0].signingIntents.length>=1);next.a.close();});
});
test('04 retired identity remains permanently blocked after fresh-channel progress and restart',async()=>{
 const s=setup();const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt});await next.a.fetch(URL);next.a.close();const prior=adapter(s);await assert.rejects(prior.a.fetch(URL),/QUARANTINED_REOPEN_REFUSED/);assert.equal(prior.records.length,0);assert.equal(prior.a.journal.read().channels[old.id].high,'1000');prior.a.close();
});
test('05 removal of reservations, attempts, high-water or retirement evidence is detected',async t=>{
 for(const [name,mutate] of [ ['reservation',x=>x.reservations=[]],['attempts',x=>x.attempts=[]],['high',x=>Object.values(x.channels)[0].high='0'],['retirement',x=>x.retirements=[]],['lifecycle',x=>Object.values(x.channels)[0].lifecycle='open'] ])await t.test(name,async()=>{const s=setup();await retired(s);edit(s,mutate);assert.throws(()=>new Journal(s.path,s.policy),/JOURNAL|RETIRED|RETIREMENT/);});
});
test('06 observed refund uncertainty never replenishes allowance or erases quarantined voucher history',async()=>{
 const s=setup({...policy,planCap:'1500000',periodCap:'1500000'});const old=await retired(s);const j=new Journal(s.path,s.policy);j.recordRefundUncertainty(old.id,'Refund claimed by remote; unverified');assert.equal(j.totals().plan,'1000000');assert.equal(j.read().channels[old.id].high,'1000');j.close();const next=adapter(s,{salt:old.r.freshSalt});await assert.rejects(next.a.fetch(URL),/PLAN_CAP/);assert.equal(next.records.length,0);next.a.close();
});
test('07 absent, failing or malformed channel reads cannot be converted into a new empty channel',async t=>{
 const readers=[['unknown',async()=>undefined],['timeout',async()=>{throw new Error('RPC_TIMEOUT');}],['string zero',async()=>['0','0']],['negative',async()=>[-1n,0n]]];
 for(const [name,readChannel] of readers)await t.test(name,async()=>{const s=setup();const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt,readChannel});await assert.rejects(next.a.fetch(URL),/UNKNOWN|RPC_TIMEOUT/);assert.equal(next.records.length,0);assert.equal(next.a.journal.totals().plan,'1000000');next.a.close();});
});
test('08 funded or historical chain state is refused instead of imported',async()=>{
 const s=setup();const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt,readChannel:async()=>[1000n,1n]});await assert.rejects(next.a.fetch(URL),/EXISTING_CHANNEL_IMPORT_UNSUPPORTED/);assert.equal(next.records.length,0);next.a.close();
});
test('09 quarantine requires explicit operator decision, clean lock, and retained known journal',async()=>{
 const s=setup();const failed=adapter(s,{transportOptions:{paid:'timeout'}});await assert.rejects(failed.a.fetch(URL));const id=Object.keys(failed.a.journal.read().channels)[0];assert.throws(()=>failed.a.journal.quarantineChannel(id),/CONFIRMATION_REQUIRED/);mkdirSync(s.path+'.lock');assert.throws(()=>failed.a.journal.quarantineChannel(id,confirm),/LOCK_BUSY_OR_STALE/);rmdirSync(s.path+'.lock');failed.a.journal.quarantineChannel(id,confirm);assert.throws(()=>failed.a.journal.quarantineChannel(id,confirm),/ALREADY_QUARANTINED/);failed.a.close();rmSync(s.path);assert.throws(()=>new Journal(s.path,s.policy),/MISSING_FAIL_CLOSED/);
});
test('10 arbitrary replacement salt is rejected; only recorded generated replacement is accepted',async()=>{
 const s=setup();await retired(s);const next=adapter(s,{salt:'0x'+'ff'.repeat(32)});await assert.rejects(next.a.fetch(URL),/FRESH_SALT_NOT_ISSUED/);assert.equal(next.records.length,0);next.a.close();
});
test('11 uncertainty on replacement still freezes new signing until another explicit decision',async()=>{
 const s=setup();const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt,transportOptions:{paid:'timeout'}});await assert.rejects(next.a.fetch(URL),/SIMULATED_POST_AUTHORIZATION_TIMEOUT/);const count=next.records.length;await assert.rejects(next.a.fetch(URL),/UNRESOLVED_AUTHORIZATION/);assert.equal(next.records.length,count);assert.equal(next.a.journal.totals().plan,'2000000');next.a.close();
});
test('12 next-period continuation retains prior reservation in its original period and plan',async()=>{
 const s=setup({...policy,periodCap:'1000000'});const old=await retired(s);const next=adapter(s,{salt:old.r.freshSalt,now:()=>new Date('2026-11-01T00:00:00Z')});await next.a.fetch(URL);assert.deepEqual(next.a.journal.totals(),{plan:'2000000',byPeriod:{'2026-10':'1000000','2026-11':'1000000'}});next.a.close();
});
test('13 strict monotone policy intentionally rejects lower next dynamic-price ceiling',async()=>{
 const s=setup();let price='1000';const wire=transport({getRequirements:()=>requirements({amount:price}),charge:'1'});const a=adapter(s,{fakeFetch:wire.fakeFetch});await a.a.fetch(URL);price='1';await assert.rejects(a.a.fetch(URL),/VOUCHER_REGRESSION/);assert.equal(a.records.length,2);a.a.close();
});

test('14 delayed SDK success/refund hooks cannot unlock retired authorization or erase history',async()=>{
 const s=setup();const old=await retired(s);const prior=adapter(s);const payload=old.before.attempts[0].payload;
 const ctx={paymentPayload:payload,requirements:payload.accepted,settleResponse:{success:true,extra:{chargedAmount:'1000'}}};
 const before=prior.a.journal.read();
 await assert.rejects(prior.a.realScheme.schemeHooks.onPaymentResponse(ctx),/CHANNEL_CLOSED_REOPEN_REFUSED/);
 const refund={...payload,payload:{...payload.payload,type:'refund',amount:'1000000'}};
 await assert.rejects(prior.a.realScheme.schemeHooks.onPaymentResponse({...ctx,paymentPayload:refund}),/CHANNEL_CLOSED_REOPEN_REFUSED/);
 assert.deepEqual(prior.a.journal.read(),before);assert.equal(prior.a.journal.totals().plan,'1000000');
 await assert.rejects(prior.a.fetch(URL),/QUARANTINED_REOPEN_REFUSED/);assert.equal(prior.records.length,0);prior.a.close();
});
test('15 operator quarantine is refused while the old transport is still in flight',async()=>{
 const s=setup();let release,atPaid;const pendingPaid=new Promise(r=>atPaid=r);const gate=new Promise(r=>release=r);
 const active=adapter(s,{transportOptions:{onPaid:async()=>{atPaid();await gate;}}});const pending=active.a.fetch(URL);await pendingPaid;
 const before=active.a.journal.read();const id=before.attempts[0].channelId;
 try {assert.throws(()=>active.a.journal.quarantineChannel(id,confirm),/LOCK_BUSY_OR_STALE/);assert.deepEqual(active.a.journal.read(),before);}finally{release();}
 await pending;assert.equal(active.a.journal.totals().plan,'1000000');assert.equal(active.a.journal.read().attempts[0].state,'acknowledged');active.a.close();
});
