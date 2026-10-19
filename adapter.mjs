// Integration proof only, deliberately conservative. Not a production security boundary.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { wrapFetchWithPayment } from '@x402/fetch';
import { BatchSettlementEvmScheme, computeChannelId } from '@x402/evm/batch-settlement/client';
import { encodeAbiParameters, keccak256 } from 'viem';

export const PINS = Object.freeze({
  scheme: 'batch-settlement', network: 'eip155:8453', chainId: 8453,
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  receiver: '0xaa0a2b5E68351C46474f4CE142A1357e25EedBA9',
  receiverAuthorizer: '0x0DA62b1f9904AB97be179579A32533210d7ebBA5',
  payer: '0x1111111111111111111111111111111111111111',
  collector: '0x4020806089470a89826cB9fB1f4059150b550004',
  settlement: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003',
  tokenDomainName: 'USD Coin', tokenDomainVersion: '2',
  voucherDomainName: 'x402 Batch Settlement', voucherDomainVersion: '1',
});
export const DEFAULT_POLICY = Object.freeze({
  plan: 'sealed-plan-example', planCap: '1500000', periodCap: '1500000',
  maxQuote: '1000000', maxDeposit: '1000000', channelVoucherCap: '3000000',
  minWithdrawDelay: 900, maxWithdrawDelay: 86400,
});
export const SALT = '0x' + '00'.repeat(32);
export const DUMMY_SIGNATURE = '0x' + '00'.repeat(65); // Invalid on purpose. Never a key.
const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const eq = (a,b) => lower(a) === lower(b);
const requireThat = (ok, reason) => { if (!ok) throw new Error(reason); };
const integer = x => typeof x === 'string' && /^(0|[1-9]\d*)$/.test(x);
const canonical = x => JSON.stringify(x);
const RECEIVE_TYPES = {ReceiveWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]};
const VOUCHER_TYPES = {Voucher:[{name:'channelId',type:'bytes32'},{name:'maxClaimableAmount',type:'uint128'}]};
const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
const periodOf = date => date.toISOString().slice(0,7); // Explicit UTC calendar-month policy.

export class Journal {
  static provision(path, policy = DEFAULT_POLICY) {
    requireThat(!existsSync(path), 'REFUSE_REINITIALIZE_JOURNAL');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE journal (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
    db.prepare('INSERT INTO journal VALUES(1, ?)').run(canonical({ schema:1, policy, policyHash:digest(policy), pinsHash:digest(PINS), reservations:[], attempts:[], channels:{}, retirements:[] }));
    db.close();
  }
  constructor(path, policy = DEFAULT_POLICY) {
    this.path = path; this.policy = policy;
    requireThat(existsSync(path), 'JOURNAL_MISSING_FAIL_CLOSED');
    this.db = new DatabaseSync(path, { open:true });
    this.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    requireThat(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'JOURNAL_CORRUPT');
    this.read();
  }
  read() {
    requireThat(existsSync(this.path), 'JOURNAL_MISSING_FAIL_CLOSED');
    let s;
    try { s = JSON.parse(this.db.prepare('SELECT body FROM journal WHERE id=1').get()?.body); }
    catch { throw new Error('JOURNAL_CORRUPT_OR_SCHEMA_MISSING'); }
    requireThat(s?.schema===1 && s.policyHash===digest(this.policy) && s.policyHash===digest(s.policy) && s.pinsHash===digest(PINS), 'JOURNAL_POLICY_OR_SCHEMA_MISMATCH');
    requireThat(Array.isArray(s.reservations) && Array.isArray(s.attempts) && s.channels && typeof s.channels==='object', 'JOURNAL_CORRUPT');
    const ids = new Set();
    for (const r of s.reservations) {
      requireThat(r.id && !ids.has(r.id) && integer(r.amount) && BigInt(r.amount)>0n && /^\d{4}-\d{2}$/.test(r.period) && r.plan===s.policy.plan && s.channels[r.channelId], 'JOURNAL_INVALID_RESERVATION'); ids.add(r.id);
    }
    for (const [id,c] of Object.entries(s.channels)) {
      requireThat(/^0x[0-9a-f]{64}$/.test(id) && c.config && integer(c.high) && ['open','closed','quarantined'].includes(c.lifecycle), 'JOURNAL_INVALID_CHANNEL');
      requireThat(computeChannelId(c.config, PINS.network).toLowerCase()===id, 'JOURNAL_CHANNEL_HASH_MISMATCH');
    }
    const attemptIds=new Set();
    for (const a of s.attempts) {
      requireThat(a.id && !attemptIds.has(a.id) && s.channels[a.channelId] && /^\d{4}-\d{2}$/.test(a.period) && ['preparing','signing','signed','exposed','uncertain','acknowledged','rejected'].includes(a.state), 'JOURNAL_INVALID_ATTEMPT');
      attemptIds.add(a.id);
      requireThat(a.signatures===undefined || (Number.isSafeInteger(a.signatures) && a.signatures>=0), 'JOURNAL_INVALID_SIGNATURE_COUNT');
      const matches=s.reservations.filter(r=>r.attemptId===a.id);
      requireThat(matches.length<=1 && ((a.depositReservationId===undefined && matches.length===0) || (matches.length===1 && matches[0].id===a.depositReservationId && matches[0].channelId===a.channelId)), 'JOURNAL_RESERVATION_LINK_BROKEN');
      if (a.payload) {
        const p=a.payload.payload;
        requireThat(p && canonical(p.channelConfig)===canonical(s.channels[a.channelId].config) && p.voucher?.channelId.toLowerCase()===a.channelId && integer(p.voucher.maxClaimableAmount) && BigInt(p.voucher.maxClaimableAmount)<=BigInt(s.channels[a.channelId].high), 'JOURNAL_PAYLOAD_HISTORY_BROKEN');
        if (p.type==='deposit') requireThat(matches.length===1 && p.deposit?.amount===matches[0].amount,'JOURNAL_DEPOSIT_HISTORY_BROKEN');
        else requireThat(p.type==='voucher' && matches.length===0,'JOURNAL_PAYLOAD_TYPE_INVALID');
      }
      requireThat(!['signed','exposed','acknowledged'].includes(a.state) || a.payload, 'JOURNAL_MISSING_SIGNED_PAYLOAD');
    }
    for (const r of s.reservations) requireThat(attemptIds.has(r.attemptId),'JOURNAL_ORPHAN_RESERVATION');
    requireThat(Array.isArray(s.retirements), 'RETIREMENT_HISTORY_MISSING');
    const retired = new Set();
    for (const r of s.retirements) {
      const c = s.channels[r.channelId];
      requireThat(c && c.lifecycle==='quarantined' && !retired.has(r.channelId), 'RETIREMENT_LINK_BROKEN');
      retired.add(r.channelId);
      requireThat(c.high===r.high && digest({config:c.config,high:c.high,attempts:s.attempts.filter(a=>a.channelId===r.channelId),reservations:s.reservations.filter(a=>a.channelId===r.channelId)})===r.historyHash, 'RETIRED_HISTORY_CHANGED');
      requireThat(r.reason && /^0x[0-9a-f]{64}$/.test(r.freshSalt) && r.freshSalt!==c.config.salt && r.operatorConfirmedStopped===true, 'RETIREMENT_RECORD_INVALID');
    }
    for (const [id,c] of Object.entries(s.channels)) requireThat(c.lifecycle!=='quarantined' || retired.has(id), 'RETIREMENT_RECORD_MISSING');
    return s;
  }
  // Explicit operator action after quiescing all users of this trusted single-host journal.
  // Does not clear attempts, erase signatures, release reservations, refund, or claim a chain outcome.
  quarantineChannel(channelId, {reason, operatorConfirmedStopped}={}) {
    requireThat(operatorConfirmedStopped===true && typeof reason==='string' && reason.trim().length>0, 'EXPLICIT_QUARANTINE_CONFIRMATION_REQUIRED');
    const lock=this.path+'.lock';
    try { mkdirSync(lock,{mode:0o700}); } catch(e) { if(e.code==='EEXIST')throw new Error('JOURNAL_LOCK_BUSY_OR_STALE'); throw e; }
    try {
      return this.mutate(s=>{
        const c=s.channels[channelId];requireThat(c && c.lifecycle!=='quarantined', 'CHANNEL_UNKNOWN_OR_ALREADY_QUARANTINED');
        requireThat(s.attempts.some(a=>a.channelId===channelId && ['signing','signed','exposed','uncertain'].includes(a.state)) || c.refundUncertainty, 'NO_UNCERTAINTY_TO_QUARANTINE');
        const freshSalt='0x'+randomBytes(32).toString('hex');
        requireThat(!Object.values(s.channels).some(ch=>ch.config.salt===freshSalt) && !s.retirements.some(r=>r.freshSalt===freshSalt), 'FRESH_SALT_COLLISION');
        const r={id:randomUUID(),channelId,high:c.high,reason:reason.trim(),at:new Date().toISOString(),operatorConfirmedStopped:true,freshSalt,
          historyHash:digest({config:c.config,high:c.high,attempts:s.attempts.filter(a=>a.channelId===channelId),reservations:s.reservations.filter(a=>a.channelId===channelId)})};
        c.lifecycle='quarantined';s.retirements.push(r);
        return structuredClone(r);
      });
    } finally { rmdirSync(lock); }
  }
  mutate(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const s=this.read(); const answer=fn(s); this.db.prepare('UPDATE journal SET body=? WHERE id=1').run(canonical(s)); this.db.exec('COMMIT'); return answer; }
    catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
  totals() {
    const s=this.read(); const byPeriod={}; let plan=0n;
    for (const r of s.reservations) { plan+=BigInt(r.amount); byPeriod[r.period]=(BigInt(byPeriod[r.period]??0)+BigInt(r.amount)).toString(); }
    return {plan:plan.toString(), byPeriod};
  }
  // No refund amount, receipt, timeout or rollover ever removes a reservation.
  recordRefundUncertainty(channelId, note='unverified refund') {
    this.mutate(s=>{ requireThat(s.channels[channelId], 'UNKNOWN_CHANNEL'); s.channels[channelId].refundUncertainty=note; });
  }
}

export function validateRequirements(r, policy=DEFAULT_POLICY) {
  requireThat(r?.scheme===PINS.scheme && r.network===PINS.network, 'UNTRUSTED_SCHEME_OR_NETWORK');
  requireThat(eq(r.asset,PINS.token) && eq(r.payTo,PINS.receiver), 'UNTRUSTED_TOKEN_OR_RECEIVER');
  requireThat(eq(r.extra?.receiverAuthorizer,PINS.receiverAuthorizer), 'UNTRUSTED_RECEIVER_AUTHORIZER');
  requireThat(r.extra?.assetTransferMethod==='eip3009', 'UNSUPPORTED_ASSET_TRANSFER');
  requireThat(r.extra?.name===PINS.tokenDomainName && r.extra?.version===PINS.tokenDomainVersion, 'UNTRUSTED_TOKEN_DOMAIN');
  requireThat(Number.isSafeInteger(r.extra?.withdrawDelay) && r.extra.withdrawDelay>=policy.minWithdrawDelay && r.extra.withdrawDelay<=policy.maxWithdrawDelay, 'UNTRUSTED_WITHDRAW_DELAY');
  requireThat(integer(r.amount) && BigInt(r.amount)>0n && BigInt(r.amount)<=BigInt(policy.maxQuote), 'QUOTE_CAP');
  requireThat(integer(r.extra?.minDeposit) && BigInt(r.extra.minDeposit)>0n && BigInt(r.extra.minDeposit)<=BigInt(policy.maxDeposit), 'DEPOSIT_HINT_CAP');
  requireThat(Number.isSafeInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds>0 && r.maxTimeoutSeconds<=300, 'AUTHORIZATION_TIMEOUT');
}

export class BudgetAdapter {
  constructor({path, fakeFetch, recordSigner, salt=SALT, policy=DEFAULT_POLICY, now=()=>new Date(), lockWaitMs=3000, beforeDepositCommit, readChannel}) {
    requireThat(/^0x[0-9a-fA-F]{64}$/.test(salt), 'INVALID_CHANNEL_SALT');
    requireThat(typeof fakeFetch==='function' && typeof recordSigner==='function', 'INJECT_DUMMY_SIGNER_AND_TRANSPORT');
    requireThat(typeof readChannel==='function', 'EXPLICIT_CHANNEL_READER_REQUIRED');
    this.path=path; this.policy=policy; this.now=now; this.lockWaitMs=lockWaitMs; this.als=new AsyncLocalStorage();
    this.journal=new Journal(path,policy);
    this.storage={
      get:async key=>{
        const c=this.journal.read().channels[key];
        if (!c) return undefined;
        requireThat(c.lifecycle==='open','CHANNEL_CLOSED_REOPEN_REFUSED');
        requireThat(!c.everAcknowledged || c.sdk!==undefined,'SDK_HISTORY_MISSING_FAIL_CLOSED');
        return c.sdk===undefined ? undefined : structuredClone(c.sdk);
      },
      set:async (key,value)=>{ this.journal.mutate(s=>{ requireThat(s.channels[key],'CHANNEL_CONTEXT_REQUIRED'); s.channels[key].sdk=structuredClone(value); }); },
      delete:async key=>{this.journal.mutate(s=>{ requireThat(s.channels[key],'UNKNOWN_CHANNEL'); s.channels[key].lifecycle='closed'; delete s.channels[key].sdk; });},
    };
    const signer={
      address:PINS.payer,
      // Injected read succeeds with explicit typed data or fails. Unknown is never converted to empty.
      readContract:async args=>{
        requireThat(eq(args.address,PINS.settlement) && args.functionName==='channels','UNEXPECTED_CHAIN_READ');
        const result=await readChannel(args);
        requireThat(Array.isArray(result) && result.length===2 && result.every(x=>typeof x==='bigint' && x>=0n) && result[1]<=result[0], 'UNKNOWN_OR_INVALID_CHANNEL_STATE');
        const c=this.journal.read().channels[args.args[0].toLowerCase()];
        requireThat(c && c.lifecycle==='open', 'CHANNEL_NOT_ACTIVE');
        // This proof supports fresh empty channels only, not funded-channel/history import.
        requireThat(result[0]===0n && result[1]===0n, 'EXISTING_CHANNEL_IMPORT_UNSUPPORTED');
        return result;
      },
      signTypedData:async typed=>{
        const scope=this.als.getStore(); requireThat(scope?.attemptId && scope.channelId,'MISSING_VALIDATED_SIGNING_CONTEXT');
        validateRequirements(scope.requirements,this.policy);
        this.validateTypedData(typed,scope);
        this.journal.mutate(s=>{
          const a=s.attempts.find(x=>x.id===scope.attemptId); requireThat(a,'ATTEMPT_MISSING');
          if (typed.primaryType==='Voucher') {
            const c=s.channels[scope.channelId]; const amount=typed.message.maxClaimableAmount;
            requireThat(amount>=BigInt(c.high),'VOUCHER_REGRESSION');
            requireThat(amount<=BigInt(this.policy.channelVoucherCap),'VOUCHER_CAP');
            c.high=amount.toString();
          }
          a.signingIntents??=[]; a.signingIntents.push(JSON.parse(JSON.stringify(typed,(_,v)=>typeof v==='bigint'?v.toString():v)));
          a.state='signing'; a.signatures=(a.signatures??0)+1;
        });
        // Persistence has committed before even asking the signer. A throwing signer is ambiguous.
        return recordSigner(typed,{journal:this.journal.read(),attemptId:scope.attemptId});
      },
    };
    this.realScheme=new BatchSettlementEvmScheme(signer,{
      salt,storage:this.storage,depositPolicy:{depositMultiplier:1000},
      depositStrategy:async context=>{
        const scope=this.als.getStore(); requireThat(scope?.channelId===context.channelId.toLowerCase(),'DEPOSIT_CONTEXT_MISMATCH');
        validateRequirements(context.paymentRequirements,this.policy);
        requireThat(canonical(context.channelConfig)===canonical(scope.config),'CHANNEL_TERMS_CHANGED');
        const prior=this.journal.read().channels[scope.channelId];
        requireThat(BigInt(context.maxClaimableAmount)>=BigInt(prior.high),'VOUCHER_REGRESSION');
        requireThat(BigInt(context.maxClaimableAmount)<=BigInt(this.policy.channelVoucherCap),'VOUCHER_CAP');
        const amount=BigInt(context.depositAmount);
        requireThat(amount>0n && amount<=BigInt(this.policy.maxDeposit),'DEPOSIT_CAP');
        // The before-commit await lets a test establish that SDK signing waits for this strategy.
        if (beforeDepositCommit) await beforeDepositCommit();
        const period=periodOf(this.now());
        this.journal.mutate(s=>{
          let plan=0n,current=0n;
          for(const r of s.reservations){plan+=BigInt(r.amount);if(r.period===period) current+=BigInt(r.amount);}
          requireThat(plan+amount<=BigInt(this.policy.planCap),'PLAN_CAP');
          requireThat(current+amount<=BigInt(this.policy.periodCap),'PERIOD_CAP');
          requireThat(!s.reservations.some(r=>r.attemptId===scope.attemptId),'DUPLICATE_DEPOSIT_RESERVATION');
          const r={id:randomUUID(),attemptId:scope.attemptId,channelId:scope.channelId,plan:this.policy.plan,period,amount:amount.toString(),state:'committed-at-authorization'};
          s.reservations.push(r); s.attempts.find(a=>a.id===scope.attemptId).depositReservationId=r.id; scope.reservationId=r.id; scope.depositAmount=r.amount;
        });
        return context.depositAmount;
      },
    });
    // Composition through public SchemeNetworkClient interface, no package modifications.
    const guardedScheme={
      scheme:this.realScheme.scheme, findDefaultAsset:this.realScheme.findDefaultAsset,
      schemeHooks:this.realScheme.schemeHooks,
      createPaymentPayload:async(version,requirements,context)=>{
        const scope=this.als.getStore();requireThat(scope,'USE_ADAPTER_FETCH');
        requireThat(!scope.attemptId,'AUTOMATIC_RECOVERY_RETRY_REQUIRES_RECONCILIATION');
        requireThat(version===2,'PROTOCOL_VERSION');validateRequirements(requirements,this.policy);
        const config=this.realScheme.buildChannelConfig(requirements);
        requireThat(eq(config.payer,PINS.payer) && eq(config.payerAuthorizer,PINS.payer) && config.salt===salt,'UNTRUSTED_PAYER_CONFIGURATION');
        const id=computeChannelId(config,requirements.network).toLowerCase();
        scope.requirements=structuredClone(requirements);scope.config=config;scope.channelId=id;scope.attemptId=randomUUID();
        this.journal.mutate(s=>{
          requireThat(!s.attempts.some(a=>['signing','signed','exposed','uncertain'].includes(a.state) && s.channels[a.channelId].lifecycle!=='quarantined'),'UNRESOLVED_AUTHORIZATION');
          const c=s.channels[id];
          if(c){requireThat(canonical(c.config)===canonical(config),'CHANNEL_TERMS_CHANGED');requireThat(c.lifecycle==='open',c.lifecycle==='quarantined'?'CHANNEL_QUARANTINED_REOPEN_REFUSED':'CHANNEL_CLOSED_REOPEN_REFUSED');requireThat(!c.refundUncertainty,'UNVERIFIED_REFUND');}
          else {
            requireThat(s.retirements.length===0 || s.retirements.some(r=>r.freshSalt===salt), 'FRESH_SALT_NOT_ISSUED_BY_QUARANTINE');
            s.channels[id]={config,high:'0',lifecycle:'open',everAcknowledged:false};
          }
          s.attempts.push({id:scope.attemptId,channelId:id,state:'preparing',period:periodOf(this.now())});
        });
        return this.realScheme.createPaymentPayload(version,requirements,context);
      },
    };
    this.client=new x402Client().register(PINS.network,guardedScheme);
    this.client.setSpendControls({allowedAssets:[{network:PINS.network,asset:PINS.token,maxAmountPerPayment:policy.maxQuote}]});
    this.client.onAfterPaymentCreation(async({paymentPayload})=>{
      const scope=this.als.getStore();const p=paymentPayload.payload;
      requireThat(canonical(p.channelConfig)===canonical(scope.config) && p.voucher.channelId.toLowerCase()===scope.channelId,'FINAL_PAYLOAD_CHANNEL_MISMATCH');
      if(p.type==='deposit') {
        requireThat(p.deposit.amount===scope.depositAmount,'FINAL_DEPOSIT_MISMATCH');
        const nonce=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[scope.channelId,BigInt(p.deposit.authorization.erc3009Authorization.salt)]));
        requireThat(nonce===scope.depositNonce,'DEPOSIT_NONCE_BINDING');
      }
      scope.payload=paymentPayload;
      this.journal.mutate(s=>{const a=s.attempts.find(a=>a.id===scope.attemptId);a.state='signed';a.payload=paymentPayload;});
    });
    this.client.onPaymentResponse(async context=>{
      const scope=this.als.getStore();
      if (!context.settleResponse) return; // Missing/corrective receipts are handled fail-closed outside.
      const receipt=context.settleResponse;
      requireThat(receipt.success===true && receipt.network===PINS.network && eq(receipt.payer,PINS.payer),'UNTRUSTED_RECEIPT');
      requireThat(integer(receipt.extra?.chargedAmount) && BigInt(receipt.extra.chargedAmount)<=BigInt(scope.requirements.amount),'UNTRUSTED_RECEIPT_CHARGE');
      const prior=this.journal.read().channels[scope.channelId].sdk??{};
      const charged=(BigInt(prior.chargedCumulativeAmount??'0')+BigInt(receipt.extra.chargedAmount)).toString();
      const reported=receipt.extra?.channelState?.chargedCumulativeAmount;
      requireThat(reported===undefined || (integer(reported) && reported===charged),'INCONSISTENT_RECEIPT_CUMULATIVE');
      const balance=(BigInt(prior.balance??'0')+BigInt(scope.payload.payload.type==='deposit'?scope.payload.payload.deposit.amount:'0')).toString();
      scope.expectedSdkState={chargedCumulativeAmount:charged,balance};
      // No recovered return: the SDK's own response hook must now update its state.
    });
    this.paidFetch=wrapFetchWithPayment(async request=>{
      if(request.headers.has('PAYMENT-SIGNATURE')){
        const scope=this.als.getStore(); const payload=decodePaymentSignatureHeader(request.headers.get('PAYMENT-SIGNATURE'));
        requireThat(canonical(payload)===canonical(scope.payload),'OUTBOUND_PAYLOAD_CHANGED');
        this.journal.mutate(s=>{s.attempts.find(a=>a.id===scope.attemptId).state='exposed';});
      }
      return fakeFetch(request);
    },this.client);
  }
  validateTypedData(t,s) {
    requireThat(t.domain.chainId===PINS.chainId,'SIGNING_CHAIN_MISMATCH');
    if(t.primaryType==='ReceiveWithAuthorization') {
      requireThat(canonical(t.types)===canonical(RECEIVE_TYPES),'SIGNING_DEPOSIT_TYPES');
      requireThat(t.domain.name===PINS.tokenDomainName && t.domain.version===PINS.tokenDomainVersion && eq(t.domain.verifyingContract,PINS.token),'SIGNING_DEPOSIT_DOMAIN');
      requireThat(eq(t.message.from,PINS.payer) && eq(t.message.to,PINS.collector),'SIGNING_DEPOSIT_PARTIES');
      const r=this.journal.read().reservations.find(r=>r.id===s.reservationId);
      requireThat(r && r.attemptId===s.attemptId && r.channelId===s.channelId && BigInt(r.amount)===t.message.value,'MISSING_COMMITTED_RESERVATION');
      const nowSeconds=BigInt(Math.floor(Date.now()/1000));
      requireThat(t.message.validAfter===0n && t.message.validBefore>=nowSeconds && t.message.validBefore<=nowSeconds+BigInt(s.requirements.maxTimeoutSeconds) && /^0x[0-9a-f]{64}$/.test(t.message.nonce),'INVALID_DEPOSIT_FIELDS');
      s.depositNonce=t.message.nonce;
    } else if(t.primaryType==='Voucher') {
      requireThat(canonical(t.types)===canonical(VOUCHER_TYPES),'SIGNING_VOUCHER_TYPES');
      requireThat(t.domain.name===PINS.voucherDomainName && t.domain.version===PINS.voucherDomainVersion && eq(t.domain.verifyingContract,PINS.settlement),'SIGNING_VOUCHER_DOMAIN');
      requireThat(t.message.channelId.toLowerCase()===s.channelId,'SIGNING_CHANNEL_MISMATCH');
      const c=this.journal.read().channels[s.channelId];
      const expected=BigInt(c.sdk?.chargedCumulativeAmount??'0')+BigInt(s.requirements.amount);
      requireThat(typeof t.message.maxClaimableAmount==='bigint' && t.message.maxClaimableAmount===expected,'UNEXPECTED_VOUCHER_AMOUNT');
    } else throw new Error('UNSUPPORTED_TYPED_DATA');
  }
  async fetch(url,init) {
    const lock=this.path+'.lock';const start=Date.now();let held=false;
    while(!held){try{mkdirSync(lock,{mode:0o700});held=true;}catch(e){if(e.code!=='EEXIST')throw e;requireThat(Date.now()-start<this.lockWaitMs,'JOURNAL_LOCK_BUSY_OR_STALE');await delay(10);}}
    try {
      this.journal.read();
      return await this.als.run({},async()=>{
        const scope=this.als.getStore();
        try {
          const response=await this.paidFetch(url,init);
          if(scope.attemptId){
            const raw=response.headers.get('PAYMENT-RESPONSE');requireThat(response.ok && raw,'UNCERTAIN_RECEIPT');
            const receipt=decodePaymentResponseHeader(raw);
            requireThat(receipt.success===true && receipt.network===PINS.network && eq(receipt.payer,PINS.payer),'UNTRUSTED_RECEIPT');
            requireThat(integer(receipt.extra?.chargedAmount) && BigInt(receipt.extra.chargedAmount)<=BigInt(scope.requirements.amount),'UNTRUSTED_RECEIPT_CHARGE');
            this.journal.mutate(s=>{
              const actual=s.channels[scope.channelId].sdk;
              requireThat(scope.expectedSdkState && actual?.chargedCumulativeAmount===scope.expectedSdkState.chargedCumulativeAmount && actual?.balance===scope.expectedSdkState.balance,'SDK_RECEIPT_STATE_NOT_APPLIED');
              s.attempts.find(a=>a.id===scope.attemptId).state='acknowledged';s.channels[scope.channelId].everAcknowledged=true;
            });
          }
          return response;
        } catch(e) {
          if(scope.attemptId) this.journal.mutate(s=>{const a=s.attempts.find(a=>a.id===scope.attemptId);if(a)a.state=(a.signatures || s.reservations.some(r=>r.attemptId===a.id))?'uncertain':'rejected';});
          throw e;
        }
      });
    } finally { rmdirSync(lock); }
  }
  close(){this.journal.close();}
}
