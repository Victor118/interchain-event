import { submitProofForSubscription } from "../../utils/watcher";

export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  if (!body.subscription_id || !body.iavl_key_hex) {
    throw createError({
      statusCode: 400,
      message: "subscription_id and iavl_key_hex are required",
    });
  }

  try {
    const result = await submitProofForSubscription(
      body.subscription_id,
      body.iavl_key_hex
    );
    return result;
  } catch (e: any) {
    throw createError({
      statusCode: 500,
      message: e.message || "Failed to submit proof",
    });
  }
});
