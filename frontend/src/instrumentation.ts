/** Runs once when the Next.js server starts (replaces the FastAPI lifespan hook). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startup } = await import("./instrumentation-node");
    await startup();
  }
}
