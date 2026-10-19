import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { PINS,SALT,DEFAULT_POLICY,DUMMY_SIGNATURE,Journal,BudgetAdapter } from '../adapter.mjs';
import { URL,requirements,transport,native } from './helpers.mjs';
const dirs=[];
function setup(options={}) {
  const dir=mkdtempSync(join(tmpdir(),'cow-sdk-proof-'));dirs.push(dir);const path=join(dir,'journal.sqlite');
  const policy={...DEFAULT_POLICY,...options.policy};Journal.provision(path,policy);
  const records=[];const wire=transport(options.transportOptions);
  const adapter=new BudgetAdapter({readChannel:async()=>[0n,0n],path,policy,fakeFetch:wire.fakeFetch,recordSigner:async(t,s)=>{records.push({typed:t,atSign:s});return DUMMY_SIGNATURE;},...options,policy});
  return {dir,path,records,wire,adapter,policy};
}
function worker(path,mode) { return new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--import','./network-guard.mjs','test/process-worker.mjs',path,...(mode?[mode]:[])],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>resolve({code,out,err,value:out?JSON.parse(out):null}));}); }
function channelId(s){return s.wire.received[0].payload.voucher.channelId.toLowerCase();}
test.after(()=>{for(const d of dirs)rmSync(d,{recursive:true,force:true});});

test('01 external fetch and sockets are blocked before SDK tests',()=>{
  assert.throws(()=>globalThis.fetch('https://example.org'),/EXTERNAL_NETWORK_DISABLED/);
  assert.throws(()=>net.connect(443,'example.org'),/EXTERNAL_NETWORK_DISABLED/);
});
test('02 native SDK permits two 1-USDC deposits despite a conceptual 1.5-USDC aggregate cap',async()=>{
  const n=native();await n.fetch(URL);await n.fetch(URL);
  const deposits=n.records.filter(x=>x.primaryType==='ReceiveWithAuthorization');
  assert.equal(deposits.length,2);assert.equal(deposits.reduce((s,x)=>s+x.message.value,0n),2000000n);
  assert.equal(n.wire.received[0].payload.type,'deposit');assert.equal(n.wire.received[1].payload.type,'deposit');
});
test('03 actual x402Client + wrapFetch + scheme obey adapter 1.5-USDC plan cap',async()=>{
  const s=setup();assert.equal((await s.adapter.fetch(URL)).status,200);
  await assert.rejects(s.adapter.fetch(URL),/PLAN_CAP/);
  assert.equal(s.records.filter(x=>x.typed.primaryType==='ReceiveWithAuthorization').length,1);
  assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.wire.received.length,1);s.adapter.close();
});
test('04 SDK awaits asynchronous depositStrategy; committed reservation precedes actual signer entry',async()=>{
  let release,enteredResolve;const gate=new Promise(r=>release=r);const entered=new Promise(r=>enteredResolve=r);
  const s=setup({beforeDepositCommit:async()=>{enteredResolve();await gate;}});
  const pending=s.adapter.fetch(URL);await entered;assert.equal(s.records.length,0);assert.equal(s.adapter.journal.totals().plan,'0');release();await pending;
  const deposit=s.records.find(x=>x.typed.primaryType==='ReceiveWithAuthorization');assert.equal(deposit.atSign.journal.reservations[0].amount,'1000000');
  assert.equal(deposit.atSign.journal.attempts[0].state,'signing');s.adapter.close();
});
test('05 process restart preserves original commitment and rejects second deposit',async()=>{
  const s=setup();await s.adapter.fetch(URL);s.adapter.close();const child=await worker(s.path);
  assert.equal(child.code,0);assert.equal(child.value.ok,false);assert.match(child.value.error,/PLAN_CAP/);assert.deepEqual(child.value.signatures,[]);assert.equal(child.value.totals.plan,'1000000');
});
test('06 concurrent adapter instances serialize full request and cannot over-authorize',async()=>{
  const s=setup();const otherRecords=[];const other=new BudgetAdapter({readChannel:async()=>[0n,0n],path:s.path,policy:s.policy,fakeFetch:transport().fakeFetch,recordSigner:async t=>{otherRecords.push(t);return DUMMY_SIGNATURE;}});
  const results=await Promise.allSettled([s.adapter.fetch(URL),other.fetch(URL)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.match(results.find(x=>x.status==='rejected').reason.message,/PLAN_CAP/);
  assert.equal(s.adapter.journal.totals().plan,'1000000');
  const recordings=[s.records.map(x=>x.typed),otherRecords];assert.equal(recordings[results.findIndex(x=>x.status==='rejected')].length,0);assert.equal(recordings.flat().filter(x=>x.primaryType==='ReceiveWithAuthorization').length,1);other.close();s.adapter.close();
});
test('07 two independent Node processes share the same durable cap and lock',async()=>{
  const s=setup();s.adapter.close();const children=await Promise.all([worker(s.path),worker(s.path)]);
  assert.equal(children.filter(x=>x.value.ok).length,1);assert.match(children.find(x=>!x.value.ok).value.error,/PLAN_CAP/);
  assert.deepEqual(children.find(x=>!x.value.ok).value.signatures,[]);assert.equal(children.flatMap(x=>x.value.signatures).filter(x=>x==='ReceiveWithAuthorization').length,1);
  const j=new Journal(s.path);assert.equal(j.totals().plan,'1000000');j.close();
});
test('08 changed channel salt cannot reset aggregate plan budget',async()=>{
  const s=setup();await s.adapter.fetch(URL);s.adapter.close();const next=new BudgetAdapter({readChannel:async()=>[0n,0n],path:s.path,policy:s.policy,salt:'0x'+'01'.repeat(32),fakeFetch:transport().fakeFetch,recordSigner:async()=>{throw new Error('must not sign');}});
  await assert.rejects(next.fetch(URL),/PLAN_CAP/);assert.equal(next.journal.totals().plan,'1000000');next.close();
});
test('09 timeout after paid payload preserves gross reservation and blocks retries',async()=>{
  const s=setup({transportOptions:{paid:'timeout'}});await assert.rejects(s.adapter.fetch(URL),/SIMULATED_POST_AUTHORIZATION_TIMEOUT/);
  assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.adapter.journal.read().attempts[0].state,'uncertain');
  const count=s.records.length;await assert.rejects(s.adapter.fetch(URL),/UNRESOLVED_AUTHORIZATION/);assert.equal(s.records.length,count);s.adapter.close();
});
test('10 signer failure is conservatively uncertain and cannot refund the cap',async()=>{
  const s=setup({recordSigner:async()=>{throw new Error('SIMULATED_SIGNER_DISCONNECT');}});await assert.rejects(s.adapter.fetch(URL),/SIMULATED_SIGNER_DISCONNECT/);
  assert.equal(s.adapter.journal.totals().plan,'1000000');await assert.rejects(s.adapter.fetch(URL),/UNRESOLVED_AUTHORIZATION/);s.adapter.close();
});
test('11 hard process exit at first signer leaves a durable reservation and stale lock',async()=>{
  const s=setup();s.adapter.close();const result=await worker(s.path,'crash-at-signer');assert.equal(result.code,73);
  const reopened=new BudgetAdapter({readChannel:async()=>[0n,0n],path:s.path,policy:s.policy,lockWaitMs:30,fakeFetch:transport().fakeFetch,recordSigner:async()=>{throw new Error('must not sign');}});
  assert.equal(reopened.journal.totals().plan,'1000000');await assert.rejects(reopened.fetch(URL),/JOURNAL_LOCK_BUSY_OR_STALE/);
  // Test-only operator removal of the stale lock still cannot erase the unresolved authorization.
  rmdirSync(s.path+'.lock');await assert.rejects(reopened.fetch(URL),/UNRESOLVED_AUTHORIZATION/);reopened.close();
});
test('12 missing journal is never silently created and removal while open fails closed',async()=>{
  const s=setup();rmSync(s.path);await assert.rejects(s.adapter.fetch(URL),/JOURNAL_MISSING_FAIL_CLOSED/);assert.equal(s.records.length,0);s.adapter.close();
  assert.throws(()=>new Journal(s.path),/JOURNAL_MISSING_FAIL_CLOSED/);
});
test('13 corrupt journal and missing schema reject before signing',()=>{
  const s=setup();s.adapter.close();writeFileSync(s.path,'not a sqlite database');assert.throws(()=>new Journal(s.path),/database|JOURNAL/);
  writeFileSync(s.path,'');assert.throws(()=>new Journal(s.path),/JOURNAL_CORRUPT_OR_SCHEMA_MISSING/);
});
test('14 native funded-channel vouchers skip depositStrategy; false does not abort signing',async()=>{
  let calls=0;const n=native({depositStrategy:()=>{calls++;return '1000000';},transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});
  await n.fetch(URL);await n.fetch(URL);assert.equal(calls,1);assert.equal(n.wire.received[1].payload.type,'voucher');
  const f=native({depositStrategy:()=>false});await f.fetch(URL);assert.equal(f.records.length,1);assert.equal(f.records[0].primaryType,'Voucher');assert.equal(f.wire.received[0].payload.type,'voucher');
});
test('15 adapter checks voucher-only cap and does not double-count vouchers as deposits',async()=>{
  const s=setup({policy:{channelVoucherCap:'2000'},transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});
  await s.adapter.fetch(URL);await s.adapter.fetch(URL);assert.equal(s.wire.received[1].payload.type,'voucher');
  assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.adapter.journal.read().reservations.length,1);
  await assert.rejects(s.adapter.fetch(URL),/VOUCHER_CAP/);assert.equal(s.adapter.journal.read().channels[channelId(s)].high,'2000');assert.equal(s.records.length,3);s.adapter.close();
});
test('16 voucher regression caused by stale channel state is blocked before signer',async()=>{
  const s=setup({transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});await s.adapter.fetch(URL);await s.adapter.fetch(URL);
  s.adapter.journal.mutate(j=>{j.channels[channelId(s)].sdk.chargedCumulativeAmount='0';});
  const before=s.records.length;await assert.rejects(s.adapter.fetch(URL),/VOUCHER_REGRESSION/);assert.equal(s.records.length,before);s.adapter.close();
});
test('17 validation runs on voucher-only requests: changed receiver, token, network, authorizer, delay and domains fail',async t=>{
  const cases=[['receiver',{payTo:'0x2222222222222222222222222222222222222222'}],['token',{asset:'0x2222222222222222222222222222222222222222'}],['network',{network:'eip155:1'}],['authorizer',{extra:{receiverAuthorizer:'0x2222222222222222222222222222222222222222'}}],['withdrawDelay',{extra:{withdrawDelay:86401}}],['name',{extra:{name:'evil'}}],['version',{extra:{version:'999'}}],['transfer',{extra:{assetTransferMethod:'permit2'}}]];
  for(const [name,change] of cases)await t.test(name,async()=>{
    let r=requirements({amount:'1000'});const s=setup({transportOptions:{getRequirements:()=>r}});await s.adapter.fetch(URL);const before=s.records.length;
    r=requirements({amount:'1000',...change});await assert.rejects(s.adapter.fetch(URL));assert.equal(s.records.length,before);assert.equal(s.wire.received.length,1);s.adapter.close();
  });
});
test('18 actual deposit and voucher typed-data domains and hashed channel nonce match pins',async()=>{
  const s=setup();await s.adapter.fetch(URL);const [d,v]=s.records.map(x=>x.typed);
  assert.equal(d.primaryType,'ReceiveWithAuthorization');assert.equal(d.domain.name,PINS.tokenDomainName);assert.equal(d.domain.version,PINS.tokenDomainVersion);assert.equal(d.domain.verifyingContract.toLowerCase(),PINS.token.toLowerCase());
  assert.equal(d.domain.chainId,8453);assert.equal(v.domain.name,PINS.voucherDomainName);assert.equal(v.domain.version,'1');assert.equal(v.domain.verifyingContract.toLowerCase(),PINS.settlement.toLowerCase());
  assert.equal(v.message.channelId,computeChannelId(s.wire.received[0].payload.channelConfig,PINS.network));assert.notEqual(d.message.nonce,v.message.channelId);
  assert.equal(s.wire.received[0].payload.deposit.authorization.erc3009Authorization.signature,DUMMY_SIGNATURE);s.adapter.close();
});
test('19 missing SDK snapshot for previously acknowledged channel fails closed without chain reconstruction',async()=>{
  const s=setup({transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});await s.adapter.fetch(URL);s.adapter.journal.mutate(j=>{delete j.channels[channelId(s)].sdk;});
  const before=s.records.length;await assert.rejects(s.adapter.fetch(URL),/SDK_HISTORY_MISSING_FAIL_CLOSED/);assert.equal(s.records.length,before);s.adapter.close();
});
test('20 closing/reopening same channel retains issuance history and refuses automatic reopen',async()=>{
  const s=setup({transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});await s.adapter.fetch(URL);const id=channelId(s);
  await s.adapter.storage.delete(id);await assert.rejects(s.adapter.fetch(URL),/CHANNEL_CLOSED_REOPEN_REFUSED/);
  assert.equal(s.adapter.journal.read().channels[id].high,'1000');assert.equal(s.adapter.journal.totals().plan,'1000000');s.adapter.close();
});
test('21 rollover changes only period allocation; original reservations and channel voucher history remain',async()=>{
  let now=new Date('2026-10-31T23:59:59Z');const s=setup({policy:{planCap:'5000000',periodCap:'1500000'},now:()=>now});await s.adapter.fetch(URL);
  await assert.rejects(s.adapter.fetch(URL),/PERIOD_CAP/);now=new Date('2026-11-01T00:00:00Z');await s.adapter.fetch(URL);
  assert.deepEqual(s.adapter.journal.totals(),{plan:'2000000',byPeriod:{'2026-10':'1000000','2026-11':'1000000'}});assert.equal(s.adapter.journal.read().channels[channelId(s)].high,'2000000');s.adapter.close();
});
test('22 rollover does not clear unresolved previous-period authorizations',async()=>{
  let now=new Date('2026-10-31T23:59:59Z');const s=setup({policy:{planCap:'5000000'},now:()=>now,transportOptions:{paid:'timeout'}});await assert.rejects(s.adapter.fetch(URL));
  now=new Date('2026-11-01T00:00:00Z');await assert.rejects(s.adapter.fetch(URL),/UNRESOLVED_AUTHORIZATION/);assert.deepEqual(s.adapter.journal.totals().byPeriod,{'2026-10':'1000000'});s.adapter.close();
});
test('23 unverified refund cannot replenish gross caps or erase voucher history',async()=>{
  const s=setup({transportOptions:{getRequirements:()=>requirements({amount:'1000'})}});await s.adapter.fetch(URL);const id=channelId(s);s.adapter.journal.recordRefundUncertainty(id,'Synthetic refund timeout');
  await assert.rejects(s.adapter.fetch(URL),/UNVERIFIED_REFUND/);assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.adapter.journal.read().channels[id].high,'1000');s.adapter.close();
});
test('24 missing or failed receipt leaves signed authorizations uncertain',async t=>{
  for(const paid of ['missing-receipt','failed'])await t.test(paid,async()=>{const s=setup({transportOptions:{paid}});await assert.rejects(s.adapter.fetch(URL),/UNCERTAIN_RECEIPT|UNTRUSTED_RECEIPT/);assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.adapter.journal.read().attempts[0].state,'uncertain');s.adapter.close();});
});
test('25 policy changes cannot silently reset existing journal accounting',()=>{
  const s=setup();s.adapter.close();assert.throws(()=>new Journal(s.path,{...DEFAULT_POLICY,planCap:'9999999'}),/JOURNAL_POLICY_OR_SCHEMA_MISMATCH/);assert.throws(()=>Journal.provision(s.path),/REFUSE_REINITIALIZE/);
});
test('26 official file-backed channel storage still allows native aggregate overspend across restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cow-sdk-native-'));dirs.push(dir);const a=native({storage:new FileClientChannelStorage({directory:dir})});await a.fetch(URL);
  const b=native({storage:new FileClientChannelStorage({directory:dir})});await b.fetch(URL);assert.equal(a.records[0].message.value+b.records[0].message.value,2000000n);
});


test('27 CoW-style per-deposit callback and durable native channel storage still do not aggregate plan budgets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cow-sdk-native-cap-'));dirs.push(dir);
  const perDeposit=({depositAmount})=>{if(BigInt(depositAmount)>1000000n)throw new Error('Per-deposit cap');return depositAmount;};
  const a=native({storage:new FileClientChannelStorage({directory:dir}),depositStrategy:perDeposit});await a.fetch(URL);
  const b=native({storage:new FileClientChannelStorage({directory:dir}),depositStrategy:perDeposit});await b.fetch(URL);
  assert.equal(a.records[0].message.value,1000000n);assert.equal(b.records[0].message.value,1000000n);
});
test('28 process exits at later authorization boundaries retain commitment and block fresh signing',async t=>{
  for(const [mode,code] of [['crash-at-voucher',74],['crash-at-paid-send',75],['crash-after-receipt-update',76]])await t.test(mode,async()=>{
    const s=setup();s.adapter.close();const result=await worker(s.path,mode);assert.equal(result.code,code);
    const reopened=new BudgetAdapter({readChannel:async()=>[0n,0n],path:s.path,policy:s.policy,lockWaitMs:20,fakeFetch:transport().fakeFetch,recordSigner:async()=>{throw new Error('must not sign');}});
    assert.equal(reopened.journal.totals().plan,'1000000');await assert.rejects(reopened.fetch(URL),/JOURNAL_LOCK_BUSY_OR_STALE/);
    rmdirSync(s.path+'.lock');await assert.rejects(reopened.fetch(URL),/UNRESOLVED_AUTHORIZATION/);reopened.close();
  });
});


test('29 semantic journal corruption cannot delete a reservation and replenish cap',async()=>{
  const s=setup();await s.adapter.fetch(URL);
  s.adapter.journal.mutate(j=>{j.reservations=[];});
  const before=s.records.length;await assert.rejects(s.adapter.fetch(URL),/JOURNAL_RESERVATION_LINK_BROKEN/);assert.equal(s.records.length,before);s.adapter.close();
});
test('30 inconsistent cumulative receipt fails before native storage mutation and remains uncertain',async()=>{
  const s=setup({policy:{planCap:'5000000',periodCap:'5000000'},transportOptions:{receiptExtra:{channelState:{chargedCumulativeAmount:'999'}}}});
  await assert.rejects(s.adapter.fetch(URL),/INCONSISTENT_RECEIPT_CUMULATIVE/);
  assert.equal(s.adapter.journal.read().attempts[0].state,'uncertain');assert.equal(s.adapter.journal.totals().plan,'1000000');
  await assert.rejects(s.adapter.fetch(URL),/UNRESOLVED_AUTHORIZATION/);assert.equal(s.records.filter(x=>x.typed.primaryType==='ReceiveWithAuthorization').length,1);s.adapter.close();
});
test('31 signer guard rejects changed type schema, deadline, and exact voucher value (unit boundary checks)',async()=>{
  const s=setup();await s.adapter.fetch(URL);const [deposit,voucher]=s.records.map(x=>x.typed);const j=s.adapter.journal.read();
  const scope={attemptId:j.attempts[0].id,channelId:channelId(s),requirements:requirements(),reservationId:j.reservations[0].id};
  const validNext=structuredClone(voucher);validNext.message.maxClaimableAmount=2000000n;assert.doesNotThrow(()=>s.adapter.validateTypedData(validNext,scope));
  const badType=structuredClone(validNext);badType.types.Voucher[1].type='uint256';assert.throws(()=>s.adapter.validateTypedData(badType,scope),/SIGNING_VOUCHER_TYPES/);
  const badDeadline=structuredClone(deposit);badDeadline.message.validBefore=2n**255n;assert.throws(()=>s.adapter.validateTypedData(badDeadline,scope),/INVALID_DEPOSIT_FIELDS/);
  const badAmount=structuredClone(validNext);badAmount.message.maxClaimableAmount=2000001n;assert.throws(()=>s.adapter.validateTypedData(badAmount,scope),/UNEXPECTED_VOUCHER_AMOUNT/);s.adapter.close();
});


test('32 native corrective-402 recovery cannot create a second authorization without reconciliation',async()=>{
  const s=setup({transportOptions:{paid:'corrective'}});
  await assert.rejects(s.adapter.fetch(URL),/AUTOMATIC_RECOVERY_RETRY_REQUIRES_RECONCILIATION/);
  assert.deepEqual(s.records.map(x=>x.typed.primaryType),['ReceiveWithAuthorization','Voucher']);assert.equal(s.wire.received.length,1);
  assert.equal(s.adapter.journal.totals().plan,'1000000');assert.equal(s.adapter.journal.read().attempts[0].state,'uncertain');s.adapter.close();
});
