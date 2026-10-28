/** Offline model transport only. Session creation, persistence and tools use the pinned SDK. */
import { createAgentSession as createRealSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
export * from "@earendil-works/pi-coding-agent";

// A changed SDK must fail the fixture rather than accidentally contact a model service.
const denyNetwork = () => {
  throw new Error("Worker integration fixture forbids network model calls");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });

export async function createAgentSession(
  options: Parameters<typeof createRealSession>[0],
) {
  const result = await createRealSession(options);
  result.session.agent.streamFunction = (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const lastUser = context.messages.findLast(
      (message) => message.role === "user",
    );
    const text =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser?.content);
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "READY" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    if (text?.includes("probe:failure")) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          ...message,
          content: [],
          stopReason: "error",
          errorMessage: "Fixture provider failure",
        },
      });
      stream.end();
      return stream;
    }
    if (text?.includes("probe:abort")) {
      void Bun.write(process.env.MOCHI_WORKER_TEST_SIGNAL!, "streaming");
      const abort = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            ...message,
            content: [],
            stopReason: "aborted",
            errorMessage: "Fixture cancelled",
          },
        });
        stream.end();
      };
      if (streamOptions?.signal?.aborted) abort();
      else
        streamOptions?.signal?.addEventListener("abort", abort, { once: true });
      return stream;
    }
    if (context.messages.at(-1)?.role === "user" && text?.includes("probe:")) {
      const write = text.includes("probe:write");
      message.content = [
        {
          type: "toolCall",
          id: crypto.randomUUID(),
          name: write ? "connector_write" : "connector_catalog",
          arguments: write
            ? {
                connection_id: "fixture",
                resource_id: "fixture",
                capability_id: "fixture",
                catalog_revision: "fixture",
                input: "{}",
                authorization_quote: "fixture",
              }
            : {},
        },
      ];
      message.stopReason = "toolUse";
    } else if (text?.includes("probe:")) {
      message.content = [
        {
          type: "text",
          text: `PROBE_COMPLETE ${JSON.stringify(context.messages.at(-1))}`,
        },
      ];
    }
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end();
    return stream;
  };
  return result;
}
