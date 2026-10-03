import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { Mppx, stripe, Transport } from "mppx/server";

function stripeConfig() {
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
  return { secretKey:secret, client:new Stripe(key,{maxNetworkRetries:2}), profile };
}
// Use Stripe SPT directly; no wallet or crypto deposit address is needed.
const spt=(c:ReturnType<typeof stripeConfig>)=>stripe.spt({client:c.client,networkId:c.profile,currency:"usd",decimals:2,paymentMethodTypes:["card"]});
export function stripePayment() {
  const c=stripeConfig();
  return Mppx.create({secretKey:c.secretKey,methods:[spt(c)]});
}
/** Same payment method over MCP: credentials and receipts travel in tool-call `_meta`. */
export function stripeMcpPayment() {
  const c=stripeConfig();
  return Mppx.create({secretKey:c.secretKey,methods:[spt(c)],transport:Transport.mcpSdk()});
}
export function stripeClient() { return stripeConfig().client; }

/** Fixed price per acquisition, in USD. */
export function acquisitionPrice() {
  const amount=Number(process.env.MPP_PRICE_USD ?? "0.50");
  if(!Number.isFinite(amount)||amount<=0||amount>100) throw new Error("Invalid MPP_PRICE_USD.");
  return { amount: amount.toFixed(2), amountMinor: Math.round(amount*100), currency: "usd" };
}
/** Keyed hash of a payment credential: replays are recognized without storing the credential itself. */
export function credentialHash(purpose: string, credential: string) {
  return createHmac("sha256",process.env.MPP_SECRET_KEY!).update(`${purpose}:${credential}`).digest("hex");
}
