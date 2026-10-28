import type { DesktopSnapshot } from "../shared/model.ts";

/** Unavailable evidence is not a signed-out account. Keep every surface consistent. */
export const accountPresentation = {
  signedIn: { button: "模型连接", title: "模型已连接", status: "已连接" },
  signedOut: {
    button: "连接模型",
    title: "尚未连接模型",
    status: "未连接",
  },
  signingIn: {
    button: "正在登录",
    title: "等待浏览器授权",
    status: "等待授权",
  },
  unknown: {
    button: "账号状态",
    title: "暂时无法确认账号",
    status: "暂时无法确认",
  },
} satisfies Record<
  DesktopSnapshot["account"]["status"],
  {
    button: string;
    title: string;
    status: string;
  }
>;
