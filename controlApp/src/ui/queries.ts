import { QueryClient, queryOptions } from "@tanstack/react-query";
import type { RuntimeModelOption } from "../../../src/runtime/protocol.ts";
import { parseSkillCatalog } from "../shared/bridge.ts";
import { type DesktopProblem, problem } from "../shared/problem.ts";
import type { ProductConnection } from "./connection.ts";

export function createDesktopQueries() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
        gcTime: 0,
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}
export class QueryProblem extends Error {
  constructor(readonly problem: DesktopProblem) {
    super(problem.code);
  }
}

export async function readModelCatalog(
  connection: ProductConnection,
): Promise<readonly RuntimeModelOption[]> {
  const result = await connection.models().catch(() => {
    throw new QueryProblem(problem("control_unavailable"));
  });
  if (!result.ok) throw new QueryProblem(result.problem);
  return result.value;
}
/**
 * The catalog one Bot may choose from.
 *
 * It is keyed by Bot because the catalog is served for the Bot the command
 * names: a cached answer for another Bot would offer models that Bot cannot use.
 */
export function modelCatalogQuery(
  connection: ProductConnection,
  botId: string | null,
) {
  return queryOptions({
    queryKey: ["model-catalog", botId],
    queryFn: () => readModelCatalog(connection),
  });
}

export function skillCatalogQuery(connection: ProductConnection) {
  return queryOptions({
    queryKey: ["skill-catalog"],
    gcTime: Number.POSITIVE_INFINITY,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const result = await connection.skills().catch(() => {
        throw new QueryProblem(problem("control_unavailable"));
      });
      if (!result.ok) throw new QueryProblem(result.problem);
      try {
        return parseSkillCatalog(result.value);
      } catch {
        throw new QueryProblem(problem("control_response_invalid"));
      }
    },
  });
}
