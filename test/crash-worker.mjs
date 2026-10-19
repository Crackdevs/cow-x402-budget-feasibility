import { BudgetAdapter, DUMMY_SIGNATURE } from '../adapter.mjs';
import { transport, requirements, URL } from './helpers.mjs';
const [path,mode,policyJSON]=process.argv.slice(2);const policy=JSON.parse(policyJSON);
const wire=transport({getRequirements:()=>requirements({amount:'1000'}),onPaid:async()=>{if(mode==='paid-send')process.exit(75);}});
const adapter=new BudgetAdapter({path,policy,fakeFetch:wire.fakeFetch,readChannel:async()=>[0n,0n],recordSigner:async t=>{
  if(mode==='first-signer')process.exit(73);
  if(mode==='voucher-signer' && t.primaryType==='Voucher')process.exit(74);
  return DUMMY_SIGNATURE;
}});
if(mode==='receipt-update'){let sets=0;const original=adapter.storage.set;adapter.storage.set=async(...args)=>{await original(...args);if(++sets===2)process.exit(76);};}
await adapter.fetch(URL);throw new Error('expected abrupt process exit');
