import { expect, test } from "@playwright/test";
import { connectedProjects } from "./connectedFacts.ts";
import type {} from "./desktop.pw.ts";

const groupAvatar = "https://s1-imfile.feishucdn.com/group-avatar";
const ownerAvatar =
  "https://avatars.githubusercontent.com/u/330909798?s=80&v=4";
const avatarImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="16" fill="#547268"/><circle cx="40" cy="40" r="18" fill="#fffdf8"/></svg>';

for (const destination of ["groups", "projects"] as const) {
  test(`${destination} avatars preserve provider identity, no-referrer and recovery`, async ({
    page,
  }) => {
    let fail = true;
    const requests: { url: string; referer: string | undefined }[] = [];
    await page.route(
      /https:\/\/(s1-imfile\.feishucdn\.com|avatars\.githubusercontent\.com)\//,
      (route) => {
        requests.push({
          url: route.request().url(),
          referer: route.request().headers().referer,
        });
        return fail
          ? route.abort()
          : route.fulfill({
              status: 200,
              contentType: "image/svg+xml",
              body: avatarImage,
            });
      },
    );
    await page.goto(`/main/settings.html?page=${destination}`);
    await page.evaluate(
      ({ project, groupAvatar }) =>
        window.mochiTest.update({
          feishuGroups: [
            {
              id: "oc_design",
              name: "产品与设计",
              avatarUrl: groupAvatar,
              enabled: true,
            },
          ],
          githubProjects: [{ ...project, ownerId: 2, fullName: "team/mochi" }],
        }),
      { project: connectedProjects[0], groupAvatar },
    );
    if (destination === "projects")
      await page
        .getByRole("button", { name: "管理访问范围", exact: true })
        .click();
    const list =
      destination === "groups"
        ? page.getByRole("region", { name: "所在群" })
        : page.getByRole("list", { name: "可选项目" });
    const control =
      destination === "groups"
        ? list.getByRole("switch")
        : list.getByRole("checkbox");
    await expect(list.locator("img")).toHaveCount(0);
    await expect(list).toContainText(
      destination === "groups" ? "产品与设计" : "team/mochi",
    );
    await expect(control).toBeEnabled();
    const before = await control.boundingBox();
    fail = false;
    await page.evaluate(
      (project) =>
        window.mochiTest.update({
          feishuGroups: [
            {
              id: "oc_design",
              name: "产品与设计",
              avatarUrl: "https://s1-imfile.feishucdn.com/recovered",
              enabled: true,
            },
          ],
          githubProjects: [
            { ...project, ownerId: 330909798, fullName: "team/mochi" },
          ],
        }),
      connectedProjects[0],
    );
    const src =
      destination === "groups"
        ? "https://s1-imfile.feishucdn.com/recovered"
        : ownerAvatar;
    const image = list.locator(`img[src="${src}"]`);
    await expect
      .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBe(80);
    expect(requests.find((request) => request.url === src)).toEqual({
      url: src,
      referer: undefined,
    });
    expect(await control.boundingBox()).toEqual(before);
    await control.click();
    await expect(control).not.toBeChecked();
  });
}

for (const surface of ["settings.html?page=projects", "index.html"]) {
  test(`project owner avatars load in ${surface} and preserve selection labels`, async ({
    page,
  }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: avatarImage,
      }),
    );
    await page.goto(`/main/${surface}`);
    await page.evaluate(
      ({ project, setup }) =>
        window.mochiTest.update({
          setup: null,
          githubProjects: [
            {
              ...project,
              ownerId: 330909798,
              fullName: "aha-labs-hq/mochi",
              selected: !setup,
            },
          ],
        }),
      { project: connectedProjects[0], setup: surface === "index.html" },
    );
    if (surface === "index.html") {
      await page.evaluate(() => window.mochiTest.beginSetup());
    }
    if (surface !== "index.html")
      await page
        .getByRole("button", { name: "管理访问范围", exact: true })
        .click();
    const list = page.getByRole("list", { name: "可选项目" });
    await expect
      .poll(() =>
        list
          .locator("img")
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBe(80);
    const selection = page.getByRole("checkbox", {
      name: "aha-labs-hq/mochi",
      exact: true,
    });
    if (surface === "index.html") await selection.click();
    await expect(selection).toBeChecked();
  });
}
