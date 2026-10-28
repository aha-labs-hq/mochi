/**
 * Feishu grants are provider facts. This presentation groups the complete
 * tenant inventory without turning a granted scope into an implemented Mochi
 * capability.
 */
export type FeishuAuthorizationGroupId =
  | "messaging"
  | "content"
  | "application"
  | "other";

export interface FeishuAuthorizationGroup {
  readonly id: FeishuAuthorizationGroupId;
  readonly title: string;
  readonly description: string;
  readonly scopes: readonly string[];
}

const GROUPS: readonly {
  readonly id: Exclude<FeishuAuthorizationGroupId, "other">;
  readonly title: string;
  readonly description: string;
  readonly prefixes: readonly string[];
}[] = [
  {
    id: "messaging",
    title: "群聊与消息",
    description: "用于群聊通道、消息接收、回复和回应。",
    prefixes: ["im:"],
  },
  {
    id: "content",
    title: "文档与知识库",
    description: "云文档、云盘元数据和知识库节点相关权限。",
    prefixes: ["docs:", "docx:", "drive:", "wiki:"],
  },
  {
    id: "application",
    title: "机器人与组织",
    description: "机器人身份、应用设置、卡片和必要的组织信息。",
    prefixes: ["application:", "cardkit:", "contact:", "admin:"],
  },
];

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "im:chat:read": "读取群聊信息",
  "im:message.group_msg": "接收群聊消息",
  "im:message:readonly": "读取消息",
  "im:message:send_as_bot": "以机器人发送消息",
  "im:message.reactions:write_only": "发送消息回应",
  "im:chat.members:bot_access": "确认机器人在群聊中的成员关系",
  "im:chat.members:read": "读取群聊成员",
  "im:chat:create": "创建群聊（当前未接入）",
  "im:chat:update": "更新群聊（当前未接入）",
  "im:message.group_at_msg.include_bot:readonly": "读取群聊中的提及消息",
  "im:message.group_at_msg:readonly": "读取群聊提及消息",
  "im:message.group_msg.include_bot:read": "读取包含机器人的群消息",
  "im:message.p2p_msg:readonly": "读取私聊消息",
  "im:message.pins:read": "读取置顶消息",
  "im:message.pins:write_only": "管理置顶消息（当前未接入）",
  "im:message.reactions:read": "读取消息回应",
  "im:message:recall": "撤回消息（当前未接入）",
  "im:message:send_multi_users": "向多人发送消息（当前未接入）",
  "im:message:send_sys_msg": "发送系统消息（当前未接入）",
  "im:message:update": "更新消息（当前未接入）",
  "im:resource": "读取消息资源",
  "docs:document.comment:create": "创建文档评论（当前未接入）",
  "docs:document.comment:delete": "删除文档评论（当前未接入）",
  "docs:document.comment:read": "读取文档评论（当前未接入）",
  "docs:document.comment:update": "更新文档评论（当前未接入）",
  "docs:document.comment:write_only": "编辑文档评论（当前未接入）",
  "docx:document.block:convert": "转换文档内容块（当前未接入）",
  "docx:document:readonly": "读取云文档",
  "docx:document:write_only": "编辑云文档（当前未接入）",
  "docx:document:create": "创建云文档（当前未接入）",
  "drive:drive.metadata:readonly": "读取云盘元数据",
  "drive:drive": "访问云盘（当前未接入）",
  "wiki:node:read": "读取知识库节点",
  "wiki:wiki:readonly": "读取知识库",
  "wiki:node:retrieve": "读取知识库节点信息",
  "application:app_slash_command:read": "读取应用命令",
  "application:app_slash_command:write": "管理应用命令（当前未接入）",
  "application:application:self_manage": "管理当前应用",
  "application:bot.basic_info:read": "读取机器人基础信息",
  "application:bot.menu:write": "管理机器人菜单（当前未接入）",
  "cardkit:card:read": "读取卡片",
  "cardkit:card:write": "管理卡片（当前未接入）",
  "contact:contact.base:readonly": "读取基础通讯录信息",
  "contact:user.basic_profile:readonly": "读取用户基础资料",
  "admin:app.info:readonly": "读取应用信息",
};

export function feishuAuthorizationGroups(
  scopes: readonly string[],
): readonly FeishuAuthorizationGroup[] {
  const unique = [...new Set(scopes)].filter((scope) => scope.length > 0);
  const grouped: FeishuAuthorizationGroup[] = GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    scopes: unique.filter((scope) =>
      group.prefixes.some((prefix) => scope.startsWith(prefix)),
    ),
  })).filter((group) => group.scopes.length > 0);
  const known = new Set(grouped.flatMap((group) => group.scopes));
  const other = unique.filter((scope) => !known.has(scope));
  if (other.length > 0) {
    grouped.push({
      id: "other",
      title: "其他已授权权限",
      description: "已由平台授予，但当前页面没有为它指定服务分类。",
      scopes: other,
    });
  }
  return grouped;
}

export function feishuScopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}
