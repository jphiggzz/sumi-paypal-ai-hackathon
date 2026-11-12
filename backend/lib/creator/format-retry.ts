import { NoObjectGeneratedError } from "ai";

// A malformed structured response gets at most one separately admitted call.
export async function retryMalformed<T>(
  generate: () => Promise<T>,
  reserve: () => Promise<number>,
  wait: (ms: number) => Promise<unknown>,
): Promise<T> {
  try {
    return await generate();
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    const delay = await reserve();
    if (delay > 30000) throw new Error("Capacity busy");
    if (delay > 0) await wait(delay);
    return generate();
  }
}
