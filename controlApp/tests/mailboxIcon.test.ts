import { describe, expect, test } from "bun:test";
import { mailboxIconUrl } from "../src/ui/mailboxIcon.ts";

describe("mailbox website icon", () => {
  test("uses only the normalized domain, independently of the mailbox name", () => {
    const icon = "https://icons.duckduckgo.com/ip3/example.com.ico";
    expect(mailboxIconUrl("team@example.com")).toBe(icon);
    expect(mailboxIconUrl("another.person+work@EXAMPLE.COM")).toBe(icon);
    expect(mailboxIconUrl("team@news.example.com")).toBe(
      "https://icons.duckduckgo.com/ip3/news.example.com.ico",
    );
    expect(mailboxIconUrl("team@例子.中国")).toBe(
      "https://icons.duckduckgo.com/ip3/xn--fsqu00a.xn--fiqs8s.ico",
    );
  });

  test("rejects addresses that could inject URL components or lack a public domain", () => {
    for (const address of [
      "",
      "team",
      "@example.com",
      "team@",
      "team@example.com@other.com",
      "team@example.com:443",
      "team@example.com/icon",
      "team@example.com?query",
      "team@example.com#hash",
      "team@example%2ecom",
      "team@example\\domain.com",
      "team@example. com",
      "team@127.0.0.1",
      "team@[::1]",
      "team@localhost",
      "team@office.local",
      "team@office.internal",
      "team@office.test",
      "team@office.invalid",
      "team@office.example",
      "team@-example.com",
      "team@example-.com",
      "team@example..com",
      `team@${"a".repeat(64)}.com`,
      `${"a".repeat(310)}@example.com`,
    ])
      expect(mailboxIconUrl(address), address).toBeNull();
  });
});
