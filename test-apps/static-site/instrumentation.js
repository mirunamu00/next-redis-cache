export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./_shared/instrumentation-node.mjs");
    await registerNode();
  }
}
