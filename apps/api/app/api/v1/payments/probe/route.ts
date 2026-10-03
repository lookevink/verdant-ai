import { createHash, createHmac } from "node:crypto";
import { Receipt } from "mppx";
import { createDatabaseRpc, queueNamespace } from "@verdant/queue";
import { stripePayment } from "../../../../../src/lib/payments";
import { queue } from "../../../../../src/lib/services";
export async function GET(request:Request) {
  // Can be deployed at the production URL, but never moves real money.
  if(process.env.PAYMENT_MODE!=="test") return Response.json({error:"not_found"},{status:404});
  let payments:ReturnType<typeof stripePayment>;
  try { payments=stripePayment(); }
  catch { return Response.json({error:"stripe_sandbox_not_configured"},{status:503}); }
  try {
    const rpc=createDatabaseRpc();
    const authorization=request.headers.get("authorization");
    const credentialKey=authorization ? createHmac("sha256",process.env.MPP_SECRET_KEY!)
      .update("verdant-payment-probe:"+authorization).digest("hex") : null;
    const saved=credentialKey ? await rpc("verdant_probe_receipt",{p_namespace:queueNamespace(),p_credential_hash:credentialKey}) as string|null : null;
    if(saved) {
      const receipt=Receipt.deserialize(saved);
      const id=createHash("sha256").update(receipt.method+":"+receipt.reference).digest("hex");
      await queue("probe").enqueue(id,{purpose:"mpp-sandbox-verification"},id,"probe");
      return Response.json({id,status:"queued",paymentMode:"test",recovered:true},
        {status:202,headers:{"Payment-Receipt":saved,"Cache-Control":"no-store"}});
    }
    const payment=await payments.charge({amount:"0.50",
      description:"Verdant sandbox payment and queue verification",
      scope:"verdant-payment-probe",meta:{environment:process.env.VERDANT_ENV??"unknown",mode:"test"},
    })(request);
    if(payment.status===402) return payment.challenge;
    const receiptResponse=payment.withReceipt(Response.json({}));
    const encodedReceipt=receiptResponse.headers.get("Payment-Receipt");
    if(!encodedReceipt) throw new Error("Missing payment receipt.");
    const receipt=Receipt.deserialize(encodedReceipt);
    // Bind fulfillment to the verified receipt, not caller-supplied idempotency data.
    if(!credentialKey) throw new Error("Payment credential is missing.");
    const id=createHash("sha256").update(receipt.method+":"+receipt.reference).digest("hex");
    await rpc("verdant_record_probe",{p_namespace:queueNamespace(),p_credential_hash:credentialKey,
      p_provider:receipt.method,p_reference:receipt.reference,p_receipt:encodedReceipt,p_job_id:id});
    return payment.withReceipt(Response.json({id,status:"queued",paymentMode:"test",
      message:"Sandbox payment verified. Diagnostic job queued; no climate data was purchased."},{status:202}));
  } catch {
    return Response.json({error:"payment_or_fulfillment_failed",
      message:"Reuse the same credential if a receipt was stored. Otherwise reconcile the Stripe payment before retrying; do not create a second payment."},{status:502});
  }
}
