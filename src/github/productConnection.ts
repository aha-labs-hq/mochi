import { productLayout, type BotLayout, type ProductLayout } from "../product/layout.ts";
import { GitHubConnection } from "./connection.ts";
import { GitHubFileCredentialStore } from "./credentials.ts";
import { GitHubConnectionError } from "./integration.ts";
import { GitHubOAuth } from "./oauth.ts";
import { GitHubWriteAuthority } from "./writeAuthority.ts";
import { readGitHubClientRegistration } from "./registration.ts";
import { log } from "../log.ts";

/** Product composition; the renderer cannot supply credential paths or issuer identity. */
export function createProductGitHubConnection(
  bot: BotLayout,
  layout: ProductLayout = productLayout(),
): GitHubConnection {
  let clientSecret: string | undefined;
  try { clientSecret = readGitHubClientRegistration(layout.githubOAuthClientPath, layout.mode === "installed" ? 0 : process.getuid!()).clientSecret; }
  catch (error) {
    // Fail this integration closed without erasing independent ChatGPT setup or Feishu facts.
    if (!(error instanceof GitHubConnectionError) || error.code !== "issuer_not_configured") throw error;
    log.warn("github.registration.unavailable", { code: error.code });
  }
  return new GitHubConnection({
    store: new GitHubFileCredentialStore(bot.githubCredentialPath),
    oauth: new GitHubOAuth(clientSecret),
    writeAuthority: new GitHubWriteAuthority(),
    changed(snapshot) {
      // The connection and its published identity belong to this Bot.
      log.info("github.connection.changed", {
        botId: bot.botId,
        status: snapshot.status,
        problem: snapshot.problem,
        accountId: snapshot.account?.id ?? null,
      });
    },
  });
}
