import { BudgetAdapter, DUMMY_SIGNATURE } from '../adapter.mjs';
import { transport, URL } from './helpers.mjs';
const [path,mode='normal']=process.argv.slice(2);
const wire=transport({onPaid:async()=>{if(mode==='crash-at-paid-send')process.exit(75);}}); const records=[];
const adapter=new BudgetAdapter({readChannel:async()=>[0n,0n],path,fakeFetch:wire.fakeFetch,recordSigner:async t=>{records.push(t.primaryType); if(mode==='crash-at-signer')process.exit(73);if(mode==='crash-at-voucher' && t.primaryType==='Voucher')process.exit(74);return DUMMY_SIGNATURE;}});
if(mode==='crash-after-receipt-update'){let sets=0;const original=adapter.storage.set;adapter.storage.set=async(...args)=>{await original(...args);if(++sets===2)process.exit(76);};}
try {await adapter.fetch(URL);console.log(JSON.stringify({ok:true,signatures:records,totals:adapter.journal.totals()}));}
catch(e){console.log(JSON.stringify({ok:false,error:e.message,signatures:records,totals:adapter.journal.totals()}));}
finally {adapter.close();}
