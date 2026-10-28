import type { GitHubRepositoryAccess } from "../src/github/botAccess.ts";
import type { GitHubRepositoryScope } from "../src/github/repository.ts";
import { GitHubRequestError } from "../src/github/requestError.ts";

export const repositoryScope: GitHubRepositoryScope = {
  accountId: 1, grantId: "a".repeat(32), repositoryId: 20, ownerId: 10, installationId: 30, selectionId: "b".repeat(32),
};

export function repositoryAccess(fetchImplementation: typeof fetch): GitHubRepositoryAccess {
  return {
    scope: repositoryScope,
    fullName: "customer/project",
    async request(
      path: string,
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      body?: unknown,
    ): Promise<unknown> {
      const response = await fetchImplementation(`https://api.github.com${path}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // The same failure classification the live connection applies.
      if (!response.ok) throw await GitHubRequestError.fromResponse(response);
      return response.status === 204 ? null : response.json();
    },
  };
}
