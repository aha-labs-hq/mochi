import { feishuServiceResourceTypeFor } from "../../lark/serviceResource.ts";
import { FeishuServiceResourceResolver } from "../../lark/serviceResourceResolver.ts";
import { ConnectorError } from "../errors.ts";
import type {
  FeishuServiceBinding,
  FeishuServiceResourceReader,
} from "./adapter.ts";

/**
 * Builds the provider reader for one binding.
 *
 * A new resolver per call is deliberate: `FeishuConnection` may replace the bound
 * app or disconnect at any time, and a cached context would let a stale binding
 * keep reading. The binding is only ever obtained from a getter that re-reads the
 * live proof.
 */
export function createFeishuServiceReader(
  binding: FeishuServiceBinding,
): FeishuServiceResourceReader {
  const resolver = new FeishuServiceResourceResolver({
    cliPath: binding.cliPath,
    profile: "mochi",
    configDirectory: binding.configDirectory,
  });
  return {
    resolve: (url, timeoutMilliseconds) =>
      resolver.resolve(url, timeoutMilliseconds),
    async read(resourceType, token, scope, address) {
      const providerType = feishuServiceResourceTypeFor(
        resourceType === "document" ? "docx" : resourceType,
      );
      if (!providerType) {
        throw new ConnectorError(
          "resource_not_selected",
          `不支持的飞书资源类型：${resourceType}`,
        );
      }
      return resolver.read(providerType, token, scope, address);
    },
  };
}
