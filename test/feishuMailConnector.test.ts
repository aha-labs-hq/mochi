import { describe, expect, test } from "bun:test";
import {
  FeishuMailConnector,
  type FeishuMailBinding,
} from "../src/connectors/feishu-mail/adapter.ts";
import {
  FeishuMailAuthorization,
  type FeishuMailAuthorizationOutcome,
} from "../src/connectors/feishu-mail/authorization.ts";
import {
  FEISHU_MAIL_MANIFEST,
  FEISHU_MAIL_PROVIDER_ID,
  FEISHU_MAIL_USER_SCOPES,
} from "../src/connectors/feishu-mail/manifest.ts";
import {
  FeishuMailReaderError,
  createFeishuMailReader,
  mailboxResourceId,
  type FeishuAccessibleMailbox,
  type FeishuMailIdentity,
  type FeishuMailReader,
  type FeishuMailThread,
  type FeishuMailThreadSummary,
} from "../src/connectors/feishu-mail/reader.ts";
import type {
  ConnectorResourceSelection,
  ConnectorSelectionStore,
} from "../src/connectors/selectionStore.ts";

const SUPPORT = "support@example.com";
const BINDING: FeishuMailBinding = {
  brand: "feishu",
  cliPath: "/usr/local/bin/lark-cli",
  profile: "mochi",
  configDirectory: "/private/tmp/feishu-mail",
  targetAppId: "cli_fixture",
  status: "ready",
  problem: null,
};
const IDENTITY: FeishuMailIdentity = {
  accountId: "ou_fixture_user",
  displayName: "测试用户",
  grantedScopes: [
    "mail:user_mailbox:readonly",
    "mail:user_mailbox.message:readonly",
    "mail:user_mailbox.message.address:read",
    "mail:user_mailbox.message.subject:read",
    "mail:user_mailbox.message.body:read",
  ],
};

class MemorySelections implements ConnectorSelectionStore {
  readonly rows = new Map<string, ConnectorResourceSelection[]>();
  connectorSelections(connectionId: string): ConnectorResourceSelection[] {
    return this.rows.get(connectionId) ?? [];
  }
  connectorSelectionConnectionIds(): readonly string[] {
    return [...this.rows.keys()];
  }
  replaceConnectorSelections(
    connectionId: string,
    selections: readonly ConnectorResourceSelection[],
  ): void {
    this.rows.set(connectionId, [...selections]);
  }
}

class FakeReader implements FeishuMailReader {
  identity: FeishuMailIdentity = IDENTITY;
  mailboxes: readonly FeishuAccessibleMailbox[] = [
    { address: SUPPORT, type: "PUBLIC_MAILBOX" },
    { address: "member@example.com", type: "USER_PRIMARY" },
  ];
  summaries: readonly FeishuMailThreadSummary[] = [
    { threadId: "thread-1", preview: "外部来信" },
  ];
  thread: FeishuMailThread = {
    threadId: "thread-1",
    messages: [
      {
        messageId: "message-1",
        threadId: "thread-1",
        subject: "需要确认的事项",
        from: { address: "customer@example.com", name: "Customer" },
        to: [{ address: SUPPORT }],
        cc: [],
        labelIds: ["UNREAD"],
        bodyPlainText: "请确认这个外部请求。",
        attachments: [],
      },
    ],
  };
  unavailable = false;
  async probe(): Promise<FeishuMailIdentity> {
    if (this.unavailable) throw new FeishuMailReaderError("provider_unavailable");
    return this.identity;
  }
  async accessibleMailboxes(): Promise<readonly FeishuAccessibleMailbox[]> {
    if (this.unavailable) throw new FeishuMailReaderError("provider_unavailable");
    return this.mailboxes;
  }
  async listThreads(): Promise<readonly FeishuMailThreadSummary[]> {
    return this.summaries;
  }
  async readThread(): Promise<FeishuMailThread> {
    return this.thread;
  }
}

/** The official CLI as the grant sees it: the device-code poll waits for the test to answer. */
function fakeCli() {
  let answer: ((approved: boolean) => void) | undefined;
  const state = { loggedOut: false };
  const run = async (
    _context: unknown,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<unknown> => {
    if (args[1] === "logout") {
      state.loggedOut = true;
      return { ok: true, loggedOut: true };
    }
    if (args[1] === "scopes") {
      return { appId: "cli_fixture", tokenType: "user", userScopes: [...FEISHU_MAIL_USER_SCOPES] };
    }
    if (args.includes("--no-wait")) {
      return {
        verification_url: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=TEST",
        device_code: "device-secret",
      };
    }
    return new Promise((resolve, reject) => {
      answer = (approved) => (approved ? resolve({}) : reject(new Error("lark-cli exited 3")));
      options?.signal?.addEventListener("abort", () => reject(new Error("lark-cli aborted")));
    });
  };
  return { run, state, answer: (approved: boolean) => answer!(approved) };
}

function build() {
  const selections = new MemorySelections();
  const reader = new FakeReader();
  const cli = fakeCli();
  const settled: FeishuMailAuthorizationOutcome[] = [];
  let notify: (() => void) | undefined;
  const connector = new FeishuMailConnector(() => BINDING, selections, () => reader, {
    flow: new FeishuMailAuthorization(cli.run),
    settled: (outcome) => {
      settled.push(outcome);
      notify?.();
    },
  });
  /** Resolves after the connector has re-proved a settled attempt. */
  const nextSettlement = () => new Promise<void>((resolve) => { notify = resolve; });
  return { selections, reader, connector, cli, settled, nextSettlement };
}

describe("Feishu mail connector", () => {
  test("declares a separate provider with read capabilities only", () => {
    expect(FEISHU_MAIL_PROVIDER_ID).toBe("feishu-mail");
    expect(FEISHU_MAIL_MANIFEST.capabilities.length).toBeGreaterThan(0);
    expect(FEISHU_MAIL_MANIFEST.capabilities.every((capability) => capability.operation === "read")).toBe(true);
    expect(FEISHU_MAIL_MANIFEST.capabilities.map((capability) => capability.id)).not.toContain("mail.send");
    expect(FEISHU_MAIL_MANIFEST.capabilities.map((capability) => capability.id)).not.toContain("mail.reply");
    expect(FEISHU_MAIL_MANIFEST.capabilities.map((capability) => capability.id)).not.toContain("mail.forward");
  });

  test("is checking before the first proof, then simply not connected without a grant", async () => {
    const { reader, connector } = build();
    const [checking] = await connector.snapshot("bot-1");
    expect(checking).toMatchObject({
      status: "unavailable",
      problem: "resource_reconciliation_required",
      account: null,
      resources: [],
    });
    reader.probe = async () => {
      throw new FeishuMailReaderError("authorization_required");
    };
    await connector.reconcile();
    await expect(connector.snapshot("bot-1")).resolves.toEqual([]);
  });

  test("a recheck keeps the published answer until the new one is known", async () => {
    const { reader, connector } = build();
    await connector.reconcile();
    const gate = Promise.withResolvers<void>();
    const probe = reader.probe.bind(reader);
    reader.probe = async () => {
      await gate.promise;
      return probe();
    };
    const recheck = connector.reconcile();
    const [during] = await connector.snapshot("bot-1");
    expect(during).toMatchObject({
      status: "ready",
      resources: [{ displayName: SUPPORT }],
    });
    gate.resolve();
    await recheck;
  });

  test("a different account's mailbox range is retired when a new account is proved", async () => {
    const { reader, selections, connector } = build();
    await connector.reconcile();
    await connector.addMailboxes([SUPPORT]);
    expect(selections.connectorSelections("feishu-mail:ou_fixture_user")).toHaveLength(1);
    reader.identity = { ...IDENTITY, accountId: "ou_other_user", displayName: "另一位用户" };
    await connector.reconcile();
    expect(selections.connectorSelections("feishu-mail:ou_fixture_user")).toEqual([]);
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      connectionId: "feishu-mail:ou_other_user",
      status: "ready",
      account: { displayName: "另一位用户" },
      resourceScope: { selectedCount: 0 },
      resources: [{ displayName: SUPPORT, selected: false }],
    });
  });

  test("disconnecting logs the user out, drops every saved mailbox and re-proves", async () => {
    const { reader, selections, connector, cli } = build();
    await connector.reconcile();
    await connector.addMailboxes([SUPPORT]);
    const probe = reader.probe.bind(reader);
    reader.probe = async () => {
      if (cli.state.loggedOut) throw new FeishuMailReaderError("authorization_required");
      return probe();
    };
    await connector.disconnect();
    expect(cli.state.loggedOut).toBe(true);
    expect(selections.connectorSelections("feishu-mail:ou_fixture_user")).toEqual([]);
    await expect(connector.snapshot("bot-1")).resolves.toEqual([]);
  });

  test("a disconnect that leaves the user signed in is reported, not assumed", async () => {
    const { connector } = build();
    await connector.reconcile();
    await expect(connector.disconnect()).rejects.toMatchObject({
      code: "authorization_unavailable",
    });
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({ status: "ready" });
  });

  test("offers only the shared mailboxes the proved user can open", async () => {
    const { connector } = build();
    await connector.reconcile();
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "ready",
      account: { displayName: "测试用户" },
      resourceScope: { status: "ready", selectedCount: 0 },
      resources: [
        { id: mailboxResourceId(SUPPORT), type: "mailbox", displayName: SUPPORT, selected: false },
      ],
    });
    // The user's own address is never an option or a published fact.
    expect(JSON.stringify(connection)).not.toContain("member@example.com");
  });

  test("completes the grant on its own once the user approves in Feishu", async () => {
    const { reader, connector, cli, settled, nextSettlement } = build();
    let proved = false;
    const probe = reader.probe.bind(reader);
    reader.probe = async () => {
      if (!proved) throw new FeishuMailReaderError("authorization_required");
      return probe();
    };
    await connector.reconcile();
    await expect(connector.startAuthorization()).resolves.toEqual({
      authorizationUrl: "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=TEST",
    });
    const [waiting] = await connector.snapshot("bot-1");
    expect(waiting).toMatchObject({ status: "authorizing", account: null });
    expect(waiting).not.toHaveProperty("problem");
    proved = true;
    const done = nextSettlement();
    cli.answer(true);
    await done;
    expect(settled).toEqual(["approved"]);
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      connectionId: "feishu-mail:ou_fixture_user",
      status: "ready",
      resources: [{ displayName: SUPPORT, selected: false }],
    });
  });

  test("says when a first grant did not finish", async () => {
    const { reader, connector, cli, nextSettlement } = build();
    reader.probe = async () => {
      throw new FeishuMailReaderError("authorization_required");
    };
    await connector.startAuthorization();
    const done = nextSettlement();
    cli.answer(false);
    await done;
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "reauthorization_required",
      problem: "mail_authorization_incomplete",
      account: null,
    });
  });

  test("cancelling a grant leaves the connection as it was", async () => {
    const { connector, settled } = build();
    await connector.reconcile();
    await connector.startAuthorization();
    await connector.cancelAuthorization();
    expect(settled).toEqual(["cancelled"]);
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({ status: "ready" });
  });

  test("an unreadable directory is unavailable rather than an empty choice", async () => {
    const { reader, connector } = build();
    reader.accessibleMailboxes = async () => {
      throw new FeishuMailReaderError("provider_unavailable");
    };
    await expect(connector.reconcile()).rejects.toMatchObject({ code: "provider_unavailable" });
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "unavailable",
      problem: "provider_unavailable",
      account: { displayName: "测试用户" },
      resources: [],
    });
  });

  test("stores only an actually accessible mailbox", async () => {
    const { selections, connector } = build();
    await connector.reconcile();
    expect(connector.connectionId()).toBe("feishu-mail:ou_fixture_user");
    await connector.addMailboxes([SUPPORT]);
    const connectionId = "feishu-mail:ou_fixture_user";
    expect(selections.connectorSelections(connectionId)).toEqual([
      {
        connectionId,
        resourceId: mailboxResourceId(SUPPORT),
        resourceType: "mailbox",
        displayName: SUPPORT,
        address: SUPPORT,
        selectionId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      },
    ]);
  });

  test("exposes the exact connection identity used by the current user proof", async () => {
    const { connector } = build();
    await connector.reconcile();
    expect(connector.connectionId()).toBe("feishu-mail:ou_fixture_user");
    expect(connector.connectionId()).not.toBe("feishu-mail:another-user");
  });

  test("choosing uses the proven directory instead of a second network read", async () => {
    const { reader, selections, connector } = build();
    await connector.reconcile();
    let reads = 0;
    reader.accessibleMailboxes = async () => {
      reads++;
      throw new FeishuMailReaderError("provider_unavailable");
    };
    await connector.addMailboxes([SUPPORT]);
    expect(reads).toBe(0);
    expect(selections.connectorSelections("feishu-mail:ou_fixture_user")).toHaveLength(1);
  });

  test("only a grant or a saved range is worth rechecking", async () => {
    const { reader, connector } = build();
    expect(connector.hasGrantToKeepFresh()).toBe(false);
    const probe = reader.probe.bind(reader);
    reader.probe = async () => {
      throw new FeishuMailReaderError("authorization_required");
    };
    await connector.reconcile();
    expect(connector.hasGrantToKeepFresh()).toBe(false);
    reader.probe = probe;
    await connector.reconcile();
    expect(connector.hasGrantToKeepFresh()).toBe(true);
  });

  test("refuses the user's own mailbox", async () => {
    const { selections, connector } = build();
    await connector.reconcile();
    await expect(connector.addMailboxes(["member@example.com"])).rejects.toMatchObject({
      code: "resource_not_selected",
    });
    expect(selections.connectorSelectionConnectionIds()).toEqual([]);
  });

  test("refuses an arbitrary mailbox address", async () => {
    const { selections, connector } = build();
    await connector.reconcile();
    await expect(connector.addMailboxes(["unknown@example.com"])).rejects.toMatchObject({
      code: "resource_not_selected",
    });
    expect(selections.connectorSelectionConnectionIds()).toEqual([]);
  });

  test("reads summaries and full threads through the selected mailbox", async () => {
    const { connector } = build();
    await connector.reconcile();
    await connector.addMailboxes([SUPPORT]);
    const [connection] = await connector.snapshot("bot-1");
    const resource = connection!.resources[0]!;
    const grant = {
      botId: "bot-1",
      connectionId: connection!.connectionId,
      resourceId: resource.id,
      capabilityId: "thread.list",
      sourceMessageId: "message-source",
      topicKey: "topic",
      requesterId: "user",
      authorizationQuote: null,
      catalogRevision: `sha256:${"0".repeat(64)}`,
    } as const;
    const context = {
      botId: "bot-1",
      sourceMessageId: "message-source",
      sourceText: "读取支持邮箱",
      topicKey: "topic",
      requesterId: "user",
    } as const;
    await expect(
      connector.read({
        context,
        grant,
        connection: connection!,
        resource,
        capability: FEISHU_MAIL_MANIFEST.capabilities[0]!,
        input: { limit: 5 },
      }),
    ).resolves.toEqual({
      mailbox: SUPPORT,
      contentTrust: "external",
      threads: [{ threadId: "thread-1", preview: "外部来信" }],
    });
    await expect(
      connector.read({
        context,
        grant: { ...grant, capabilityId: "thread.read" },
        connection: connection!,
        resource,
        capability: FEISHU_MAIL_MANIFEST.capabilities[1]!,
        input: { thread_id: "thread-1" },
      }),
    ).resolves.toMatchObject({
      mailbox: SUPPORT,
      contentTrust: "external",
      threadId: "thread-1",
    });
  });

  test("keeps selected mailboxes when the provider is temporarily unavailable", async () => {
    const { selections, reader, connector } = build();
    await connector.reconcile();
    await connector.addMailboxes([SUPPORT]);
    reader.unavailable = true;
    await connector.reconcile();
    expect(selections.connectorSelections("feishu-mail:ou_fixture_user")).toHaveLength(1);
    const [connection] = await connector.snapshot("bot-1");
    expect(connection).toMatchObject({
      status: "unavailable",
      resourceScope: { status: "unavailable", selectedCount: 1 },
    });
  });
});

describe("Feishu mail reader", () => {
  /** `auth status --verify` output for the user identity, as lark-cli 1.0.93 prints it. */
  const probeWith = (user: Record<string, unknown>) =>
    createFeishuMailReader(
      { cliPath: "/usr/local/bin/lark-cli", profile: "mochi", configDirectory: "/private/tmp/mail" },
      async () => ({
        identity: "user",
        verified: true,
        identities: { user: { openId: "ou_user", userName: "用户", scope: "mail:user_mailbox:readonly", ...user } },
      }),
    ).probe();

  test("a token refreshed during verification is a proven identity, not a lapsed grant", async () => {
    // The CLI refreshes an expired access token, verifies it with the server,
    // and still reports the stored pre-refresh state.
    await expect(
      probeWith({ status: "needs_refresh", tokenStatus: "needs_refresh", available: true, verified: true }),
    ).resolves.toMatchObject({ accountId: "ou_user", grantedScopes: ["mail:user_mailbox:readonly"] });
  });

  test("an unverified, rejected or missing user identity needs authorization", async () => {
    for (const user of [
      { status: "needs_refresh", tokenStatus: "needs_refresh", available: true },
      { status: "verify_failed", available: false, verified: false },
      { status: "missing" },
    ]) {
      await expect(probeWith(user)).rejects.toMatchObject({ code: "authorization_required" });
    }
  });

  test("uses only explicit read commands and decodes bounded body data", async () => {
    const calls: string[][] = [];
    const body = Buffer.from("来自邮件的正文", "utf8").toString("base64url");
    const reader = createFeishuMailReader(
      {
        cliPath: "/usr/local/bin/lark-cli",
        profile: "mochi",
        configDirectory: "/private/tmp/mail",
      },
      async (_context, args) => {
        calls.push([...args]);
        if (args[0] === "auth") {
          return {
            ok: true,
            verified: true,
            identities: {
              user: {
                status: "ready",
                available: true,
                verified: true,
                tokenStatus: "valid",
                openId: "ou_user",
                userName: "用户",
                scope: "mail:user_mailbox:readonly",
              },
            },
          };
        }
        if (args[1] === "user_mailboxes") {
          return { ok: true, data: { accessible_mailboxes: [{ email_address: SUPPORT, email_type: "PUBLIC_MAILBOX" }] } };
        }
        if (args[1] === "user_mailbox.threads") {
          return { ok: true, data: { items: [{ id: "thread-1", body_preview: "摘要" }] } };
        }
        return {
          ok: true,
          data: {
            thread: {
              id: "thread-1",
              messages: [{
                message_id: "message-1",
                thread_id: "thread-1",
                body_plain_text: body,
                to: [],
                cc: [],
                label_ids: [],
                attachments: [],
              }],
            },
          },
        };
      },
    );
    await reader.probe();
    await reader.accessibleMailboxes();
    await expect(reader.listThreads({ mailbox: SUPPORT, limit: 20 })).resolves.toEqual([
      { threadId: "thread-1", preview: "摘要" },
    ]);
    const thread = await reader.readThread({ mailbox: SUPPORT, threadId: "thread-1" });
    expect(thread.messages[0]!.bodyPlainText).toBe("来自邮件的正文");
    expect(calls.flat().join(" ")).not.toContain("+send");
    expect(calls.flat().join(" ")).not.toContain("+reply");
    expect(calls.flat().join(" ")).not.toContain("+forward");
    expect(calls.some((args) => args.includes("+thread"))).toBe(true);
    const listCall = calls.find((args) => args.includes("user_mailbox.threads"));
    expect(listCall).toBeDefined();
    const listParams = JSON.parse(listCall![listCall!.indexOf("--params") + 1]!);
    expect(listParams).toMatchObject({ folder_id: "INBOX" });
  });
});
