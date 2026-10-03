export async function POST() {
  // Never charge or enqueue data requests until the acquisition handler exists.
  return Response.json({error:"acquisition_not_ready",
    message:"Data requests will require verified MPP payment. Acquisition is not enabled yet."},{status:503});
}
