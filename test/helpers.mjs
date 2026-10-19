import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { BatchSettlementEvmScheme, InMemoryClientChannelStorage } from '@x402/evm/batch-settlement/client';
import { PINS, SALT, DUMMY_SIGNATURE } from '../adapter.mjs';
export const URL='https://synthetic.invalid/quote';
export function requirements(overrides={}) {
  const base={scheme:'batch-settlement', network:PINS.network, amount:'1000000', asset:PINS.token, payTo:PINS.receiver,maxTimeoutSeconds:60,
    extra:{name:PINS.tokenDomainName,version:PINS.tokenDomainVersion,assetTransferMethod:'eip3009',receiverAuthorizer:PINS.receiverAuthorizer,withdrawDelay:900,minDeposit:'1000000'}};
  return {...base,...overrides,extra:{...base.extra,...overrides.extra}};
}
export function transport({getRequirements=()=>requirements(), paid='success', charge, onPaid, receiptExtra={}}={}) {
  const received=[]; let calls=0;
  const fakeFetch=async request=>{
    calls++;
    const signature=request.headers.get('PAYMENT-SIGNATURE');
    if(!signature) {const paymentRequired={x402Version:2,resource:{url:URL,description:'Synthetic CoW-style quote fixture',mimeType:'application/json'},accepts:[getRequirements()]};return new Response(null,{status:402,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader(paymentRequired)}});}
    const payload=decodePaymentSignatureHeader(signature);received.push(payload);
    if(onPaid)await onPaid(payload);
    if(paid==='corrective')return new Response(null,{status:402,headers:{'PAYMENT-REQUIRED':encodePaymentRequiredHeader({x402Version:2,error:'invalid_batch_settlement_evm_cumulative_amount_mismatch',resource:{url:URL},accepts:[getRequirements()]})}});
    if(paid==='timeout')throw new Error('SIMULATED_POST_AUTHORIZATION_TIMEOUT');
    if(paid==='missing-receipt')return new Response('{"quote":{}}',{status:200});
    const receipt={success:paid!=='failed',network:PINS.network,payer:PINS.payer,transaction:'0x'+'00'.repeat(32),extra:{chargedAmount:charge??payload.accepted.amount,...receiptExtra}};
    return new Response('{"quote":{"synthetic":true}}',{status:200,headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(receipt)}});
  };
  return {fakeFetch,received,get calls(){return calls;}};
}
export function recordingSigner(records=[], extra={}) {return {address:PINS.payer,signTypedData:async t=>{records.push(t);return DUMMY_SIGNATURE;},...extra};}
export function native({records=[],storage=new InMemoryClientChannelStorage(),salt=SALT,depositStrategy,transportOptions={}}={}) {
  const wire=transport(transportOptions);const signer=recordingSigner(records);
  const scheme=new BatchSettlementEvmScheme(signer,{storage,salt,depositPolicy:{depositMultiplier:3},...(depositStrategy?{depositStrategy}:{})});
  const client=new x402Client().register(PINS.network,scheme).setSpendControls({allowedAssets:[{network:PINS.network,asset:PINS.token,maxAmountPerPayment:'1000000'}]});
  return {fetch:wrapFetchWithPayment(wire.fakeFetch,client),scheme,client,wire,storage,records};
}
