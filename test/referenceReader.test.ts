import { describe, expect, test } from "bun:test";
import {
  FeishuReferenceReader,
  type LarkJsonRunner,
} from "../src/lark/referenceReader.ts";
import { FeishuServiceResourceResolver } from "../src/lark/serviceResourceResolver.ts";

describe("Feishu reference reader", () => {
  test("reads an allowlisted Docx URL through official shortcuts", async () => {
    const url = "https://example.feishu.cn/docx/doc123";
    const calls: string[][] = [];
    const run: LarkJsonRunner = async (_context, args) => {
      calls.push([...args]);
      if (args[0] === "drive") return { ok: true, data: { type: "docx", title: "Design" } };
      return { ok: true, data: { content: "# Design\nBody" } };
    };
    const result = await new FeishuReferenceReader({ cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" }, run).read(url);
    expect(result).toEqual({
      url,
      inspect: { type: "docx", title: "Design" },
      content: { content: "# Design\nBody" },
    });
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["drive", "+inspect"],
      ["docs", "+fetch"],
    ]);
    expect(calls[0]).toContain(url);
    expect(calls[1]).toContain(url);
    expect(calls[1]).toContain("im-markdown");
  });

  test("returns authoritative metadata instead of inventing a reader for other objects", async () => {
    const url = "https://example.feishu.cn/sheets/sht123";
    const run: LarkJsonRunner = async () => ({ ok: true, data: { type: "sheet", title: "Plan" } });
    expect(await new FeishuReferenceReader({ cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" }, run).read(url)).toEqual({
      url,
      inspect: { type: "sheet", title: "Plan" },
      content: null,
      limitation: "content_reader_not_available_for_sheet",
    });
  });

  test("reads a Wiki URL through the document fetch path", async () => {
    const url = "https://example.feishu.cn/wiki/wiki123";
    const calls: string[][] = [];
    const run: LarkJsonRunner = async (_context, args) => {
      calls.push([...args]);
      if (args[0] === "drive") {
        return {
          ok: true,
          data: { type: "wiki", token: "wiki123", title: "团队知识" },
        };
      }
      return { ok: true, data: { content: "# 团队知识\n正文" } };
    };
    const result = await new FeishuReferenceReader(
      {
        cliPath: "/lark-cli",
        profile: "bot",
        configDirectory: "/private/test-config",
      },
      run,
    ).read(url);
    expect(result.inspect).toEqual({
      type: "wiki",
      token: "wiki123",
      title: "团队知识",
    });
    expect(result.content).toEqual({ content: "# 团队知识\n正文" });
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["drive", "+inspect"],
      ["docs", "+fetch"],
    ]);
  });

  test("rejects a provider token with an unsafe shape before reading it", async () => {
    const calls: string[][] = [];
    const run: LarkJsonRunner = async (_context, args) => {
      calls.push([...args]);
      return {
        ok: true,
        data: { type: "docx", token: "token.with.dot", title: "设计" },
      };
    };
    await expect(
      new FeishuServiceResourceResolver(
        {
          cliPath: "/lark-cli",
          profile: "bot",
          configDirectory: "/private/test-config",
        },
        run,
      ).resolve("https://example.feishu.cn/docx/unsafe"),
    ).rejects.toMatchObject({ code: "metadata_incomplete" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["drive", "+inspect"]);
  });

  test("distinguishes malformed provider responses from missing metadata", async () => {
    const context = {
      cliPath: "/lark-cli",
      profile: "bot",
      configDirectory: "/private/test-config",
    } as const;
    await expect(
      new FeishuReferenceReader(context, async () => ({ ok: true })).inspect(
        "https://example.feishu.cn/docx/doc123",
      ),
    ).rejects.toMatchObject({
      name: "FeishuReferenceError",
      code: "provider_response_invalid",
    });
    await expect(
      new FeishuReferenceReader(context, async () => ({
        ok: true,
        data: { type: "docx" },
      })).inspect("https://example.feishu.cn/docx/doc123"),
    ).rejects.toMatchObject({
      name: "FeishuReferenceError",
      code: "metadata_incomplete",
    });
  });

  test("keeps runner transport failures separate from provider response failures", async () => {
    const context = {
      cliPath: "/lark-cli",
      profile: "bot",
      configDirectory: "/private/test-config",
    } as const;
    await expect(
      new FeishuReferenceReader(context, async () => {
        throw new Error("socket closed");
      }).inspect("https://example.feishu.cn/docx/doc123"),
    ).rejects.toMatchObject({
      name: "FeishuReferenceError",
      code: "provider_unavailable",
    });
    await expect(
      new FeishuReferenceReader(context, async () => {
        throw new SyntaxError("invalid JSON");
      }).inspect("https://example.feishu.cn/docx/doc123"),
    ).rejects.toMatchObject({
      name: "FeishuReferenceError",
      code: "provider_response_invalid",
    });
  });

  test("rejects URLs outside Feishu and Lark before invoking the CLI", async () => {
    let calls = 0;
    const run: LarkJsonRunner = async () => {
      calls += 1;
      return {};
    };
    await expect(new FeishuReferenceReader({ cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" }, run).read("https://example.com/docx/doc123"))
      .rejects.toThrow("host is not allowed");
    expect(calls).toBe(0);
  });

  test("rejects a provider canonical URL outside Feishu and Lark before fetching", async () => {
    const calls: string[][] = [];
    const run: LarkJsonRunner = async (_context, args) => {
      calls.push([...args]);
      return {
        ok: true,
        data: {
          type: "docx",
          token: "doc123",
          title: "Design",
          url: "https://evil.example/docx/doc123",
        },
      };
    };
    await expect(
      new FeishuReferenceReader(
        { cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" },
        run,
      ).read("https://example.feishu.cn/docx/doc123"),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
    expect(calls.map((call) => call.slice(0, 2))).toEqual([["drive", "+inspect"]]);
  });

  test("keeps readable content while exposing a provider limitation", async () => {
    const url = "https://example.feishu.cn/docx/doc123";
    const run: LarkJsonRunner = async (_context, args) =>
      args[0] === "drive"
        ? { ok: true, data: { type: "docx", token: "doc123", title: "Design" } }
        : { ok: true, data: { content: "# Design", tips: "embedded content omitted" } };
    const result = await new FeishuReferenceReader(
      { cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" },
      run,
    ).read(url);
    expect(result).toMatchObject({
      content: { content: "# Design" },
      limitation: "document_content_partial",
    });
  });

  test("can fix a resource when its readable body has a bounded limitation", async () => {
    const url = "https://example.feishu.cn/docx/doc123";
    const run: LarkJsonRunner = async (_context, args) =>
      args[0] === "drive"
        ? { ok: true, data: { type: "docx", token: "doc123", title: "Design" } }
        : { ok: true, data: { content: "# Design", tips: "embedded content omitted" } };
    await expect(
      new FeishuServiceResourceResolver(
        { cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" },
        run,
      ).resolve(url),
    ).resolves.toMatchObject({
      resourceId: "document:doc123",
      displayName: "Design",
      address: url,
    });
  });

  test("rejects a second lookup that returns a different resource identity", async () => {
    let inspectCalls = 0;
    const run: LarkJsonRunner = async (_context, args) => {
      if (args[0] === "drive") {
        inspectCalls += 1;
        return {
          ok: true,
          data: {
            type: "docx",
            token: inspectCalls === 1 ? "doc123" : "other456",
            title: "Design",
          },
        };
      }
      return { ok: true, data: { content: "# Design" } };
    };
    await expect(
      new FeishuServiceResourceResolver(
        { cliPath: "/lark-cli", profile: "bot", configDirectory: "/private/test-config" },
        run,
      ).resolve("https://example.feishu.cn/docx/doc123"),
    ).rejects.toMatchObject({ code: "provider_response_invalid" });
  });

  test("keeps the provider's Lark origin when fixing a resource", async () => {
    const url = "https://workspace.larksuite.com/docx/doc123";
    const run: LarkJsonRunner = async (_context, args) => {
      if (args[0] === "drive") {
        return {
          ok: true,
          data: {
            type: "docx",
            token: "doc123",
            title: "Design",
            url,
          },
        };
      }
      return { ok: true, data: { content: "# Design\nBody" } };
    };
    const resolved = await new FeishuServiceResourceResolver(
      {
        cliPath: "/lark-cli",
        profile: "bot",
        configDirectory: "/private/test-config",
      },
      run,
    ).resolve(url);
    expect(resolved.address).toBe(url);
  });
});
