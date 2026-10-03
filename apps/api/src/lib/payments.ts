import Stripe from "stripe";
import { Mppx, stripe } from "mppx/server";
export function stripePayment() {
  const key=process.env.STRIPE_SECRET_KEY;
  const profile=process.env.STRIPE_PROFILE_ID;
  const secret=process.env.MPP_SECRET_KEY;
  const mode=process.env.PAYMENT_MODE;
  if(!key||!profile||!secret||!["test","live"].includes(mode??""))
    throw new Error("Stripe MPP configuration is incomplete.");
  const isTest=/^(sk|rk|rkcs)_test_/.test(key);
  if(isTest !== (mode==="test")) throw new Error("Stripe key and payment mode disagree.");
  if(!/^(sk|rk|rkcs)_(test|live)_/.test(key)||!profile.startsWith("profile_"))
    throw new Error("Invalid Stripe configuration.");
  if(process.env.VERDANT_ENV==="sandbox" && mode!=="test") throw new Error("Live payments are forbidden in sandbox.");
  if (profile.startsWith("profile_test_") !== isTest) throw new Error("Stripe profile and key mode disagree.");
  // Use Stripe SPT directly; no wallet or crypto deposit address is needed.
  return Mppx.create({secretKey:secret,methods:[stripe.spt({
    client:new Stripe(key,{maxNetworkRetries:2}),
    networkId:profile,currency:"usd",decimals:2,paymentMethodTypes:["card"],
  })]});
}
