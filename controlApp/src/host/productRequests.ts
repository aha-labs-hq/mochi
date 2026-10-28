import { parseInstructionsRequest } from "../../../src/agent/instructionDocument.ts";
import { log } from "../../../src/log.ts";
import { parseAction } from "../shared/actions.ts";
import type { Result } from "../shared/model.ts";
import { fail, projectFailure } from "../shared/problem.ts";
import type { DesktopController } from "./controller.ts";

/** Both trusted windows call the same controller through the same validators. */
export function productRequests(
  controller: DesktopController,
  run: <T>(operation: () => Promise<Result<T>>) => Promise<Result<T>>,
) {
  const scoped = (input: unknown, field?: "action" | "request") => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid product request");
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        (field ? [field, "botId"].sort().join(",") : "botId") ||
      (value.botId !== null &&
        (typeof value.botId !== "string" ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.botId)))
    )
      throw new Error("Invalid product request scope");
    if (value.botId !== controller.snapshot.selectedBotId)
      fail("bot_view_changed");
    return field ? value[field] : undefined;
  };
  return {
    perform: async (input: unknown) => {
      try {
        return await run(() =>
          controller.perform(parseAction(scoped(input, "action"))),
        );
      } catch (error) {
        log.warn("rpc.rejected");
        return {
          ok: false as const,
          problem: projectFailure(error, "control_response_invalid"),
        };
      }
    },
    instructions: async (input: unknown) => {
      try {
        return await run(() =>
          controller.instructions(
            parseInstructionsRequest(scoped(input, "request")),
          ),
        );
      } catch (error) {
        return {
          ok: false as const,
          problem: projectFailure(error, "control_response_invalid"),
        };
      }
    },
    models: async (input: unknown) => {
      try {
        return await run(() => {
          scoped(input);
          return controller.models();
        });
      } catch (error) {
        return {
          ok: false as const,
          problem: projectFailure(error, "control_response_invalid"),
        };
      }
    },
    skills: async (input: unknown) => {
      try {
        return await run(() => {
          scoped(input);
          return controller.skills();
        });
      } catch (error) {
        return {
          ok: false as const,
          problem: projectFailure(error, "control_response_invalid"),
        };
      }
    },
    schedules: async (input: unknown) => {
      try {
        return await run(() => {
          scoped(input);
          return controller.schedules();
        });
      } catch (error) {
        return {
          ok: false as const,
          problem: projectFailure(error, "control_response_invalid"),
        };
      }
    },
  };
}
