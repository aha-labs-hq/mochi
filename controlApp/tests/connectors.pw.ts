import { expect, test } from "@playwright/test";
import QRCode from "qrcode";
import {
  connectedBotId,
  connectedFacts,
  feishuMailConnection,
} from "./connectedFacts.ts";

/**
 * The connector page uses one provider-neutral card contract: connection
 * identity, selected access scope and available operations. Feishu's services
 * are stated from the facts the code can prove: the account grant already
 * covers document and wiki reads, so nothing here asks the user to authorize
 * them again.
 */
test("connector catalog lists providers as peers and opens each one's own page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=connectors");

  const main = page.getByRole("main", { name: "设置内容" });
  const cards = main.locator("article[data-provider-id]");
  await expect(
    main.getByRole("heading", { name: "连接器", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "打开 GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "打开 文档与知识库", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "连接 共享邮箱", exact: true }),
  ).toBeVisible();
  await expect(
    cards.nth(0).getByText("customer", { exact: true }),
  ).toBeVisible();
  await expect(main.getByText("当前连接", { exact: true })).toBeVisible();
  await expect(main.getByText("2 个已连接", { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('[data-connector-zone="identity"]')).toHaveCount(
    3,
  );
  await expect(cards.locator('[data-connector-zone="details"]')).toHaveCount(3);
  await expect(cards.getByText("连接身份", { exact: true })).toHaveCount(3);
  await expect(cards.getByText("访问范围", { exact: true })).toHaveCount(3);
  await expect(cards.getByText("可用操作", { exact: true })).toHaveCount(3);
  await expect(
    cards.nth(0).getByText("读取 · 1 项", { exact: true }),
  ).toBeVisible();
  await expect(
    cards.nth(1).getByText("读取 · 1 项", { exact: true }),
  ).toBeVisible();
  await expect(
    cards.nth(1).getByText("读取 · 1 项可选固定", { exact: true }),
  ).toBeVisible();
  await expect(
    main.getByText("customer/mochi", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "打开 GitHub", exact: true }),
  ).toContainText("连接");
  await expect(
    main.getByRole("button", { name: "打开 文档与知识库", exact: true }),
  ).toContainText("连接");
  await expect(
    main.getByRole("button", { name: "连接 共享邮箱", exact: true }),
  ).toContainText("连接");
  // Feishu resources are what exists, not what might.
  await expect(
    main.getByText("产品说明", { exact: true }).first(),
  ).toBeVisible();
  // A message channel is not a connector.
  await expect(
    main.getByRole("heading", { name: "群聊", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "项目", exact: true }),
  ).toHaveCount(0);

  await main.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await expect(
    main.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
  ).toBeVisible();
  await expect(main.getByRole("list", { name: "已选择项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^返回/ })).toBeVisible();
  await page.getByRole("button", { name: /^返回/ }).click();
  // The detail page stays mounted but hidden, so returning is asserted as
  // visibility of the catalog rather than removal of the child route.
  await expect(
    main.getByRole("heading", { name: "GitHub", level: 1, exact: true }),
  ).toBeHidden();
  await expect(
    main.getByRole("button", { name: "打开 GitHub", exact: true }),
  ).toBeVisible();
});

test("the Feishu service page states each capability's real state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=feishuServices");

  const main = page.getByRole("main", { name: "设置内容" });
  const detail = main.locator(":scope > section:not([hidden])");
  // A connector's resources are a child of the connector category. The one
  // back link names that parent, so the title needs no second breadcrumb.
  await expect(
    detail.getByRole("heading", { name: "文档与知识库", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "返回 连接器" })).toBeVisible();
  await expect(
    detail.getByText("连接器", { exact: true }).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(detail.getByText("已连接", { exact: true })).toHaveCount(2);
  await expect(
    detail.getByText("沿用群聊机器人的连接", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByLabel("文档或知识库链接")).toHaveCount(0);
  await detail.locator("summary").filter({ hasText: "读取" }).click();
  await expect(detail.getByText("可用", { exact: true })).toHaveCount(1);
  await expect(
    detail.getByText(
      "这 1 份资料麻薯会一直参考；群里临时发的链接，只在那条消息里读取",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    detail.getByRole("region", { name: "机器人权限" }),
  ).toBeVisible();
  await expect(detail.locator("[data-feishu-scope-count='41']")).toBeVisible();
  await expect(detail.getByText("群聊与消息", { exact: true })).toBeVisible();
  await expect(
    detail
      .getByRole("region", { name: "机器人权限" })
      .getByText("文档与知识库", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("机器人与组织", { exact: true })).toBeVisible();
  // Management opens by default here: the shared bot needs explaining.
  await expect(
    detail.getByText(
      "沿用群聊机器人授权，不需要为文档另外登录。每份资料能否读到，看它分享给了谁。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "管理群聊机器人", exact: true }),
  ).toBeVisible();
  // The Bot rechecks its authorization on its own; nothing here refreshes.
  await expect(
    detail.getByRole("button", { name: /刷新|重新检查/ }),
  ).toHaveCount(0);
  await expect(
    detail.getByText("已授权 · 未接入", { exact: true }),
  ).toHaveCount(0);
  await expect(
    detail.getByText(
      "目前能读云文档和知识库，还不能读多维表格，也不会修改文档。",
      { exact: true },
    ),
  ).toBeVisible();
  await detail.getByRole("button", { name: "固定资料", exact: true }).click();
  await expect(detail.getByLabel("文档或知识库链接")).toBeFocused();
});

test("the Feishu shared mailbox is set up by one grant and one choice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=feishuMail");

  const main = page.getByRole("main", { name: "设置内容" });
  const detail = main.locator(":scope > section:not([hidden])");
  const lastAction = () => page.evaluate(() => window.mochiTest.actions.at(-1));
  const showMail = (
    connection: ReturnType<typeof feishuMailConnection> | null,
    qr: string | null = null,
  ) =>
    page.evaluate(
      ({ facts, connection, qr }) => {
        window.mochiTest.update({
          connectorCatalog: {
            ...facts.connectorCatalog!,
            connections: [
              ...facts.connectorCatalog!.connections,
              ...(connection ? [connection] : []),
            ],
          },
          feishuMailVerificationQr: qr,
          canReopenFeishuMailAuthorization: qr !== null,
        });
      },
      { facts: connectedFacts, connection, qr },
    );

  // Never granted: plainly not connected, with one next step.
  await expect(
    detail.getByRole("heading", { name: "共享邮箱", exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("未连接", { exact: true })).toBeVisible();
  await expect(detail.getByText("尚未授权", { exact: true })).toBeVisible();
  await expect(detail.getByText("飞书邮箱用户")).toHaveCount(0);
  await expect(
    detail.getByRole("heading", { name: "访问范围", exact: true }),
  ).toHaveCount(0);
  // A first grant pauses nothing, so a working Bot does not block it.
  await page.evaluate(() => window.mochiTest.update({ phase: "working" }));
  await detail
    .getByRole("button", { name: "授权读取邮箱", exact: true })
    .click();
  expect(await lastAction()).toEqual({ type: "authorizeFeishuMail" });
  await page.evaluate(() => window.mochiTest.update({ phase: "listening" }));

  // Waiting for Feishu: no "I'm done" step; the page updates itself.
  await showMail(
    feishuMailConnection("authorizing"),
    "data:image/png;base64,iVBORw0KGgo=",
  );
  await expect(detail.getByText("等待授权", { exact: true })).toBeVisible();
  await expect(
    detail.getByRole("img", { name: "用飞书扫码，授权读取共享邮箱" }),
  ).toBeVisible();
  await expect(
    detail.getByText("确认后这里会自动更新", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByRole("button", { name: /我已完成/ })).toHaveCount(0);
  await detail
    .getByRole("button", { name: "在浏览器中打开", exact: true })
    .click();
  expect(await lastAction()).toEqual({
    type: "reopenFeishuMailAuthorization",
  });
  await detail.getByRole("button", { name: "取消授权", exact: true }).click();
  expect(await lastAction()).toEqual({ type: "cancelFeishuMailAuthorization" });

  // A reopened window has no code to show yet; continuing fetches the same one.
  await showMail(feishuMailConnection("authorizing"));
  await detail.getByRole("button", { name: "继续授权", exact: true }).click();
  expect(await lastAction()).toEqual({ type: "authorizeFeishuMail" });

  // Before the first check the page says it is checking, not disconnected.
  await showMail(feishuMailConnection("checking"));
  await expect(
    detail.getByText("正在确认", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    detail.getByText("正在确认邮箱授权", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("未连接", { exact: true })).toHaveCount(0);

  // A first grant that never finished says so and offers the same step.
  await showMail(feishuMailConnection("incomplete"));
  await expect(detail.getByText("授权未完成", { exact: true })).toBeVisible();
  await expect(
    detail.getByText("上次授权没有完成，可能已过期或被取消。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "重新授权", exact: true }),
  ).toBeVisible();

  // The app itself lacks the mail scopes: the error leads to Feishu's own page.
  await showMail(null);
  await page.evaluate(() =>
    window.mochiTest.failAction(
      "feishu_mail_app_scope_required",
      "authorizeFeishuMail",
    ),
  );
  await detail
    .getByRole("button", { name: "授权读取邮箱", exact: true })
    .click();
  await expect(
    detail.getByText(
      "Mochi 的机器人应用还没有开通读取邮箱的权限，需要应用管理员在对应的开放平台开通。开通后回到这里再授权一次。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() => window.mochiTest.failAction(null));
  await detail
    .getByRole("button", { name: "去飞书开通权限", exact: true })
    .click();
  expect(await lastAction()).toEqual({ type: "feishuMailSettings" });
  await expect(
    detail.getByText(
      "已在浏览器打开飞书开放平台。开通邮件读取权限后，回到这里再授权一次。",
      { exact: true },
    ),
  ).toBeVisible();

  // Granted: the proven shared mailboxes are listed; nothing is typed.
  await showMail(feishuMailConnection("ready"));
  await expect(detail.getByText("已连接", { exact: true })).toBeVisible();
  await expect(detail.getByText("林小满", { exact: true })).toBeVisible();
  await expect(detail.getByRole("textbox")).toHaveCount(0);
  await expect(
    detail.getByRole("heading", { name: "访问范围", exact: true }),
  ).toBeVisible();
  const list = detail.getByRole("list", { name: "共享邮箱" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  // The list keeps a calm, stable shape: one switch per mailbox, rows ordered
  // by address, and no refresh control because the Bot keeps it current.
  const order = () =>
    list
      .getByRole("listitem")
      .evaluateAll((items) =>
        items.map((item) => item.textContent?.match(/\S+@\S+?\.com/)?.[0]),
      );
  expect(await order()).toEqual(["billing@example.com", "support@example.com"]);
  await expect(
    detail.getByRole("button", { name: /刷新|重新检查/ }),
  ).toHaveCount(0);
  const support = list.getByRole("switch", {
    name: "support@example.com：读取邮件",
    exact: true,
  });
  await expect(support).not.toBeChecked();
  await support.click();
  expect(await lastAction()).toEqual({
    type: "addConnectorResources",
    connectionId: "feishu-mail:ou_fixture_user",
    references: ["support@example.com"],
  });

  await showMail(feishuMailConnection("selected"));
  await expect(support).toBeChecked();
  await expect(
    list.getByText("读取邮件 · 只读", { exact: true }),
  ).toBeVisible();
  expect(await order()).toEqual(["billing@example.com", "support@example.com"]);
  await support.click();
  expect(await lastAction()).toEqual({
    type: "removeConnectorResource",
    connectionId: "feishu-mail:ou_fixture_user",
    resourceId: `mailbox:${"a".repeat(32)}`,
    selectionId: "c".repeat(32),
  });

  // A grant missing read scopes keeps the list and asks for the grant again.
  await showMail(feishuMailConnection("partial"));
  await expect(
    detail.getByText(
      "这次授权没有包含读取邮件需要的全部权限，Mochi 还不能读取会话。重新授权即可补齐。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "重新授权", exact: true }),
  ).toBeVisible();

  // The boundary is stated once, inside connection management, beside the
  // way out of a grant made with the wrong account.
  await showMail(feishuMailConnection("selected"));
  await detail.getByText("连接管理", { exact: true }).click();
  await expect(
    detail.getByText(
      "没有发送、回复、转发、草稿、删除、移动或修改收信规则的能力",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "重新检查授权" }),
  ).toHaveCount(0);
  // Replacing the grant in use pauses reads, so it waits for the Bot's work.
  await page.evaluate(() => window.mochiTest.update({ phase: "working" }));
  const switchAccount = detail.getByRole("button", {
    name: "换一个账号授权",
    exact: true,
  });
  await expect(switchAccount).toBeDisabled();
  await page.evaluate(() => window.mochiTest.update({ phase: "listening" }));
  await switchAccount.click();
  expect(await lastAction()).toEqual({ type: "authorizeFeishuMail" });
  const disconnect = detail.getByRole("button", {
    name: "断开授权…",
    exact: true,
  });
  await page.evaluate(() => window.mochiTest.update({ phase: "working" }));
  await expect(disconnect).toBeDisabled();
  await expect(
    detail.getByText("当前工作完成后，可以更换或断开授权。", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.mochiTest.update({ phase: "listening" }));
  await disconnect.click();
  expect(await lastAction()).toEqual({ type: "disconnectFeishuMail" });

  // The grant rides on the Bot's Feishu App: a lost App is a different next
  // step from one that was never connected.
  await showMail(null);
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        feishu: {
          ...facts.feishu,
          active: { ...facts.feishu.active!, state: "unavailable" },
        },
      }),
    connectedFacts,
  );
  await expect(
    detail.getByText(
      "这位伙伴的群聊连接需要处理。恢复后，邮箱授权和已选择的邮箱会继续生效。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "查看群聊连接", exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({ feishu: { ...facts.feishu, active: null } }),
    connectedFacts,
  );
  await expect(
    detail.getByRole("button", { name: "连接群聊", exact: true }),
  ).toBeVisible();
});

for (const width of [360, 640, 1040]) {
  test(`feishu mail detail ${width}: setup and choice fit without overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 716 });
    await page.goto("/main/settings.html?page=feishuMail");
    const main = page
      .getByRole("main", { name: "设置内容" })
      .locator(":scope > section:not([hidden])");
    const code = await QRCode.toDataURL(
      "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=TEST",
      { margin: 4, scale: 6 },
    );
    for (const [state, qr] of [
      ["authorizing", code],
      ["selected", null],
    ] as const) {
      await page.evaluate(
        ({ facts, connection, qr }) => {
          window.mochiTest.update({
            connectorCatalog: {
              ...facts.connectorCatalog!,
              connections: [...facts.connectorCatalog!.connections, connection],
            },
            feishuMailVerificationQr: qr,
            canReopenFeishuMailAuthorization: qr !== null,
          });
        },
        { facts: connectedFacts, connection: feishuMailConnection(state), qr },
      );
      if (state === "selected") {
        await expect(
          main.getByRole("heading", { name: "访问范围", exact: true }),
        ).toBeVisible();
        await expect(main.locator("[data-connector-section]")).toHaveCount(3);
      } else {
        await expect(
          main.getByRole("button", { name: "取消授权", exact: true }),
        ).toBeInViewport();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(
        await main.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/connector-page-audit/feishu-mail-${state}-${width}.png`,
        animations: "disabled",
      });
    }
  });
}

test("Feishu presents authorization before optional resource pinning", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  await page.evaluate((facts) => {
    window.mochiTest.update({
      connectorCatalog: {
        ...facts.connectorCatalog!,
        connections: facts.connectorCatalog!.connections.map((connection) =>
          connection.providerId === "feishu-service"
            ? {
                ...connection,
                resources: [],
                resourceScope: {
                  ...connection.resourceScope,
                  selectedCount: 0,
                },
                capabilities: connection.capabilities.map((capability) => ({
                  ...capability,
                  availability: "selection_required" as const,
                })),
              }
            : connection,
        ),
      },
    });
  }, connectedFacts);

  const detail = page
    .getByRole("main", { name: "设置内容" })
    .locator(":scope > section:not([hidden])");
  await expect(
    detail.getByText("可以读取云文档", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText(
      "群里分享的文档和知识库链接，会在那条消息里读取，不用逐份授权。想让麻薯一直参考某份资料，再把它固定下来。",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(detail.getByLabel("文档或知识库链接")).toHaveCount(0);
  await expect(detail.getByText("可选固定资料", { exact: true })).toHaveCount(
    2,
  );
  await detail.getByRole("button", { name: "固定资料", exact: true }).click();
  await expect(detail.getByLabel("文档或知识库链接")).toBeFocused();
});

test("Feishu keeps a saved fixed range visible while it is unavailable", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  await page.evaluate((facts) => {
    window.mochiTest.update({
      connectorCatalog: {
        ...facts.connectorCatalog!,
        connections: facts.connectorCatalog!.connections.map((connection) =>
          connection.providerId === "feishu-service"
            ? {
                ...connection,
                resourceScope: {
                  status: "unavailable" as const,
                  selectedCount: 1,
                  problem: "provider_unavailable",
                },
                capabilities: connection.capabilities.map((capability) => ({
                  ...capability,
                  availability: "resource_unavailable" as const,
                })),
              }
            : connection,
        ),
      },
    });
  }, connectedFacts);
  const detail = page
    .getByRole("main", { name: "设置内容" })
    .locator(":scope > section:not([hidden])");
  await expect(detail.getByText("产品说明", { exact: true })).toBeVisible();
  await expect(
    detail.getByText("已固定 · 暂不可用", { exact: false }),
  ).toBeVisible();
  await expect(
    detail.getByText("固定资料暂时无法确认", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "移除 产品说明", exact: true }),
  ).toBeEnabled();
  await detail
    .getByRole("button", { name: "移除 产品说明", exact: true })
    .click();
  await expect(
    detail.getByText("可以读取云文档", { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText("产品说明", { exact: true })).toHaveCount(0);
});

test("Feishu keeps local fixed range manageable when the connection is unavailable", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  await page.evaluate((facts) => {
    window.mochiTest.update({
      connectorCatalog: {
        ...facts.connectorCatalog!,
        connections: facts.connectorCatalog!.connections.map((connection) =>
          connection.providerId === "feishu-service"
            ? {
                ...connection,
                status: "unavailable" as const,
                problem: "provider_unavailable",
                resourceScope: {
                  status: "unavailable" as const,
                  selectedCount: 1,
                  problem: "provider_unavailable",
                },
                capabilities: connection.capabilities.map((capability) => ({
                  ...capability,
                  availability: "connection_unavailable" as const,
                })),
              }
            : connection,
        ),
      },
    });
  }, connectedFacts);
  const detail = page
    .getByRole("main", { name: "设置内容" })
    .locator(":scope > section:not([hidden])");
  await expect(detail.getByText("产品说明", { exact: true })).toBeVisible();
  await expect(
    detail.getByText("连接暂不可用 · 已固定", { exact: false }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "移除 产品说明", exact: true }),
  ).toBeEnabled();
  await detail
    .getByRole("button", { name: "移除 产品说明", exact: true })
    .click();
  await expect(detail.getByText("产品说明", { exact: true })).toHaveCount(0);
  await expect(
    detail.getByText("已取消固定，原文保留。", { exact: true }),
  ).toBeVisible();
});

test("Feishu additions retain failed input, then add and remove only the chosen content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1040, height: 716 });
  await page.goto("/main/settings.html?page=feishuServices");
  const input = page.getByLabel("文档或知识库链接");
  await page.getByRole("button", { name: "固定资料", exact: true }).click();
  await input.fill("https://acme.feishu.cn/docx/SECOND");
  await page.evaluate(() =>
    window.mochiTest.failAction(
      "connector_selection_failed",
      "addConnectorResources",
    ),
  );
  await page.getByRole("button", { name: "确认固定", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("https://acme.feishu.cn/docx/SECOND");
  expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
    dirty: true,
    busy: false,
  });
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "确认固定", exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "已固定资料" }).getByRole("listitem"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "移除 新增文档", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "已固定资料" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole("list", { name: "已固定资料" })
      .getByText("产品说明", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("已取消固定，原文保留。", {
      exact: true,
    }),
  ).toBeVisible();
  expect((await page.evaluate(() => window.mochiTest.actions)).at(-1)).toEqual({
    type: "removeConnectorResource",
    connectionId: "feishu:app_fixture",
    resourceId: "document:SECOND",
    selectionId: "f".repeat(32),
  });
});

test("Feishu link drafts stay with their Bot across navigation and disconnects", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  const otherId = "22222222-2222-4222-8222-222222222222";
  await page.evaluate(
    ({ bots, otherId }) =>
      window.mochiTest.update({
        bots: [...bots, { ...bots[0]!, botId: otherId, label: "星野" }],
      }),
    { bots: connectedFacts.bots, otherId },
  );
  const input = page.getByLabel("文档或知识库链接");
  const firstLink = "https://acme.feishu.cn/docx/FIRST";
  const secondLink = "https://acme.feishu.cn/docx/SECOND";
  await page.getByRole("button", { name: "固定资料", exact: true }).click();
  await input.fill(firstLink);
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await page.getByRole("button", { name: "连接器", exact: true }).click();
  await page
    .getByRole("button", { name: "打开 文档与知识库", exact: true })
    .click();
  await expect(input).toHaveCount(0);
  await page.getByRole("button", { name: "固定资料", exact: true }).click();
  await input.fill(secondLink);
  await page.getByRole("button", { name: "设置麻薯", exact: true }).click();
  await expect(input).toHaveValue(firstLink);
  await page.evaluate(() =>
    window.mochiTest.update({ connectorCatalog: null, controlReady: false }),
  );
  await expect(input).toHaveValue(firstLink);
  await expect(input).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "确认固定", exact: true }),
  ).toBeDisabled();
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        connectorCatalog: facts.connectorCatalog,
        controlReady: true,
      }),
    connectedFacts,
  );
  await expect(input).toBeEnabled();
  await page.getByRole("button", { name: "确认固定", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    true,
  );
  await page.getByRole("button", { name: "设置星野", exact: true }).click();
  await expect(input).toHaveValue(secondLink);
  await page.getByRole("button", { name: "确认固定", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    false,
  );
  expect(
    await page.evaluate(() =>
      window.mochiTest.botWrites.filter(
        (write) => write.kind === "addConnectorResources",
      ),
    ),
  ).toEqual([
    { botId: connectedBotId, kind: "addConnectorResources" },
    { botId: otherId, kind: "addConnectorResources" },
  ]);
});

test("Feishu pending work disables repeated submissions and unknown grants stay unknown", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  const input = page.getByLabel("文档或知识库链接");
  await page.getByRole("button", { name: "固定资料", exact: true }).click();
  await input.fill("https://acme.feishu.cn/docx/SECOND");
  await page.evaluate(() => window.mochiTest.holdActions());
  await page.getByRole("button", { name: "确认固定", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在确认…", exact: true }),
  ).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "移除 产品说明", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => window.mochiTest.closeState())).toEqual({
    dirty: true,
    busy: true,
  });
  await page.evaluate(() => window.mochiTest.releaseActions());
  await expect(input).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({ connectorCatalog: null, controlReady: false }),
  );
  await expect(input).toHaveCount(0);
  await expect(page.getByText("未授权", { exact: true })).toHaveCount(0);
  await expect(page.getByText("已授权", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .locator(":scope > section:not([hidden])")
      .getByText("无法确认", { exact: true }),
  ).toHaveCount(2);
});

test("GitHub separates browser authorization, empty grants and unapplied selection", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(() =>
    window.mochiTest.update({
      github: { status: "authorizing", account: null },
      canReopenGitHubLogin: true,
    }),
  );
  await expect(
    page.getByRole("button", { name: "继续 GitHub 授权", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("还没有可选项目", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("list", { name: "可选项目" })).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({
      github: { status: "connected", account: { login: "customer" } },
      githubProjects: [],
    }),
  );
  await expect(
    page.getByRole("button", { name: "去 GitHub 选择项目", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "连接 GitHub", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.mochiTest.update({
      github: { status: "connected", account: { login: "customer" } },
      githubProjects: [
        { id: 20, fullName: "customer/mochi", selected: true },
        { id: 21, fullName: "customer/guide", selected: false },
      ],
    }),
  );
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "customer/guide", exact: true })
    .check();
  await expect(
    page.getByText("已勾选 2 个 · 尚未保存", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.mochiTest.failAction("github_selection_failed", "selectProjects"),
  );
  await page.getByRole("button", { name: "保存项目选择", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "customer/guide", exact: true }),
  ).toBeChecked();
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page.getByRole("button", { name: "保存项目选择", exact: true }).click();
  await expect(
    page.getByText("已选择 2 个项目", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await page
    .getByRole("textbox", { name: "查找 GitHub 项目" })
    .fill("no-match");
  await expect(
    page.getByText("没有匹配的项目。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("已选择 2 个项目", { exact: true }),
  ).toBeVisible();
});

test("GitHub allows a working Bot's draft, then discards it without changing saved scope", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(() =>
    window.mochiTest.update({
      phase: "working",
      githubProjects: [
        { id: 20, fullName: "customer/mochi", selected: true },
        { id: 21, fullName: "customer/guide", selected: false },
      ],
    }),
  );
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  const choice = page.getByRole("checkbox", {
    name: "customer/guide",
    exact: true,
  });
  await expect(choice).toBeEnabled();
  await choice.check();
  await expect(
    page.getByRole("button", { name: "保存项目选择", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("可以先勾选项目，当前工作完成后再保存。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "放弃更改", exact: true }).click();
  await expect(page.getByRole("list", { name: "已选择项目" })).toContainText(
    "customer/mochi",
  );
  await expect(
    page.getByRole("list", { name: "已选择项目" }),
  ).not.toContainText("customer/guide");
  await expect(
    page.getByRole("button", { name: "管理访问范围", exact: true }),
  ).toBeFocused();
  expect((await page.evaluate(() => window.mochiTest.closeState())).dirty).toBe(
    false,
  );
  expect(
    (await page.evaluate(() => window.mochiTest.actions)).filter(
      (action) => action.type === "selectProjects",
    ),
  ).toEqual([]);
});

test("GitHub preserves a draft through temporary uncertainty and distinguishes revoked authorization", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.getByRole("button", { name: "管理访问范围", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "customer/mochi", exact: true })
    .uncheck();
  await page.evaluate(() =>
    window.mochiTest.update({ connectorCatalog: null, controlReady: false }),
  );
  await expect(
    page.getByRole("button", { name: "重新授权 GitHub", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "连接 GitHub", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        connectorCatalog: facts.connectorCatalog,
        controlReady: true,
      }),
    connectedFacts,
  );
  await expect(
    page.getByRole("checkbox", { name: "customer/mochi", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByText("已勾选 0 个 · 尚未保存", { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        connectorCatalog: {
          ...facts.connectorCatalog!,
          connections: facts.connectorCatalog!.connections.map((connection) =>
            connection.providerId === "github"
              ? {
                  ...connection,
                  status: "unavailable",
                  capabilities: connection.capabilities.map((capability) => ({
                    ...capability,
                    availability: "connection_unavailable" as const,
                  })),
                  resources: [],
                }
              : connection,
          ),
        },
      }),
    connectedFacts,
  );
  // A connection Feishu or GitHub did not confirm is retried by the Bot.
  await expect(
    page.getByText("暂时无法确认 GitHub 连接，Mochi 会自动重试。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /重新检查|刷新/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "重新授权 GitHub", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        connectorCatalog: {
          ...facts.connectorCatalog!,
          connections: facts.connectorCatalog!.connections.map((connection) =>
            connection.providerId === "github"
              ? {
                  ...connection,
                  status: "reauthorization_required",
                  capabilities: connection.capabilities.map((capability) => ({
                    ...capability,
                    availability: "connection_unavailable" as const,
                  })),
                  resources: [],
                }
              : connection,
          ),
        },
      }),
    connectedFacts,
  );
  await expect(
    page.getByRole("button", { name: "重新授权 GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("GitHub 授权已失效，请重新授权后继续访问。", {
      exact: true,
    }),
  ).toBeVisible();
});

test("GitHub explains known read-only scope without asking the user to choose it again", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=projects");
  await page.evaluate(
    (facts) =>
      window.mochiTest.update({
        connectorCatalog: {
          ...facts.connectorCatalog!,
          connections: facts.connectorCatalog!.connections.map((connection) =>
            connection.providerId === "github"
              ? {
                  ...connection,
                  resources: connection.resources.map((resource) => ({
                    ...resource,
                    writable: false,
                  })),
                  capabilities: connection.capabilities.map((capability) => ({
                    ...capability,
                    availability:
                      capability.operation === "write" ? "read_only" : "ready",
                  })),
                }
              : connection,
          ),
        },
      }),
    connectedFacts,
  );
  const detail = page
    .getByRole("main")
    .locator(":scope > section:not([hidden])");
  await detail.locator("summary").filter({ hasText: "写入" }).click();
  await expect(
    detail.getByRole("list").getByText("所选内容只读", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("设置访问范围后可用", { exact: true }),
  ).toHaveCount(0);
});

test("Feishu allows preparing input while working and localizes a failed removal to its item", async ({
  page,
}) => {
  await page.goto("/main/settings.html?page=feishuServices");
  await page.evaluate(() => window.mochiTest.update({ phase: "working" }));
  await page.getByRole("button", { name: "固定资料", exact: true }).click();
  const input = page.getByLabel("文档或知识库链接");
  await expect(input).toBeEnabled();
  await input.fill("https://acme.feishu.cn/docx/SECOND");
  await expect(
    page.getByRole("button", { name: "确认固定", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "放弃输入", exact: true }).click();
  await page.evaluate(() => {
    window.mochiTest.update({ phase: "listening" });
    window.mochiTest.failAction(
      "connector_selection_failed",
      "removeConnectorResource",
    );
  });
  await page
    .getByRole("button", { name: "移除 产品说明", exact: true })
    .click();
  const item = page
    .getByRole("list", { name: "已固定资料" })
    .getByRole("listitem");
  await expect(item.getByRole("alert")).toBeVisible();
  await expect(item).toContainText("产品说明");
  await page.evaluate(() => window.mochiTest.failAction(null));
  await page
    .getByRole("button", { name: "移除 产品说明", exact: true })
    .click();
  await expect(input).toHaveCount(0);
  await expect(page.getByText("可以读取云文档", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "已固定资料" })).toHaveCount(0);
});

for (const [provider, route] of [
  ["github", "projects"],
  ["feishu", "feishuServices"],
] as const) {
  for (const width of [360, 640, 1040]) {
    test(`${provider} detail ${width}: shared hierarchy fits and secondary management is reachable`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 716 });
      // Capture the real neutral fallback, without depending on a public
      // account's avatar or a network response for visual evidence.
      await page.route("https://avatars.githubusercontent.com/**", (route) =>
        route.abort(),
      );
      await page.goto(`/main/settings.html?page=${route}`);
      const main = page
        .getByRole("main", { name: "设置内容" })
        .locator(":scope > section:not([hidden])");
      await expect(
        main.locator("[data-connector-section=connection]"),
      ).toContainText("已连接");
      await expect(main.getByText("授权方式", { exact: true })).toHaveCount(0);
      await expect(
        main.getByRole("heading", { name: "访问范围", exact: true }),
      ).toBeVisible();
      await expect(
        main.getByRole("region", { name: "访问范围内的操作" }),
      ).toBeVisible();
      await expect(main.locator("[data-connector-section]")).toHaveCount(3);
      await page.screenshot({
        path: `artifacts/connector-page-audit/${provider}-detail-refined-${width}.png`,
        animations: "disabled",
      });
      if (provider === "github") {
        await main.locator("summary").filter({ hasText: "连接管理" }).click();
      }
      const managementAction = main.getByRole("button", {
        name: provider === "github" ? "断开连接…" : "管理群聊机器人",
        exact: true,
      });
      await managementAction.scrollIntoViewIfNeeded();
      await expect(managementAction).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      expect(
        await main.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/connector-page-audit/${provider}-management-refined-${width}.png`,
        animations: "disabled",
      });
      await main.locator("summary").filter({ hasText: "连接管理" }).click();
      await main
        .getByRole("button", {
          name: provider === "github" ? "管理访问范围" : "固定资料",
          exact: true,
        })
        .click();
      const input = main.getByRole("textbox", {
        name: provider === "github" ? "查找 GitHub 项目" : "文档或知识库链接",
        exact: true,
      });
      await expect(input).toBeFocused();
      const submit = main.getByRole("button", {
        name: provider === "github" ? "保存项目选择" : "确认固定",
        exact: true,
      });
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport();
      expect(
        await main.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/connector-page-audit/${provider}-editor-refined-${width}.png`,
        animations: "disabled",
      });
    });
  }
}
