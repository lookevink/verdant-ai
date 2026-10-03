import test from 'node:test';
import assert from 'node:assert/strict';
import { stripePayment } from './payments';

test('Stripe challenge requires coherent server-side test configuration without calling Stripe',async()=>{
 const keys=['VERDANT_ENV','PAYMENT_MODE','STRIPE_SECRET_KEY','STRIPE_PROFILE_ID','MPP_SECRET_KEY'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try {
  Object.assign(process.env,{VERDANT_ENV:'sandbox',PAYMENT_MODE:'test',
   STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PROFILE_ID:'profile_test_fixture',MPP_SECRET_KEY:'test-secret-for-local-protocol-verification'});
  const payment=await stripePayment().charge({amount:'0.50'})(new Request('https://verdant.example/probe'));
  assert.equal(payment.status,402);
  if(payment.status===402) assert.match(payment.challenge.headers.get('WWW-Authenticate')??'',/Payment/);
  process.env.STRIPE_SECRET_KEY='sk_live_fixture';assert.throws(stripePayment,/mode disagree/);
  process.env.PAYMENT_MODE='live';assert.throws(stripePayment,/forbidden in sandbox/);
  process.env.PAYMENT_MODE='test';process.env.STRIPE_SECRET_KEY='sk_test_fixture';
  process.env.STRIPE_PROFILE_ID='profile_live_fixture';assert.throws(stripePayment,/profile and key mode disagree/);
  delete process.env.STRIPE_PROFILE_ID;assert.throws(stripePayment,/incomplete/);
 } finally {
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
