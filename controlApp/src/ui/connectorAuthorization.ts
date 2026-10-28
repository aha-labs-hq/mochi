/** Presentation protocol; provider connection owners still perform authorization. */
export interface ConnectorAuthorizationDefinition {
  readonly acquisition:
    | {
        readonly kind: "interactive";
        readonly interaction: "redirect" | "code" | "qr";
      }
    | { readonly kind: "secret" }
    | { readonly kind: "inherited"; readonly source: string }
    | { readonly kind: "public" };
  readonly principal:
    | "user"
    | "application"
    | "user_and_application"
    | "service_account"
    | "public";
  readonly resources: readonly (
    | "message_context"
    | "provider_selection"
    | "catalog_selection"
    | "explicit_reference"
    | "account_scope"
  )[];
  readonly administratorApproval: "none" | "possible";
}

export function authorizationMethodLabel(
  definition: ConnectorAuthorizationDefinition,
): string {
  switch (definition.acquisition.kind) {
    case "interactive":
      return {
        redirect: "官方网页登录",
        code: "官方验证码登录",
        qr: "官方扫码连接",
      }[definition.acquisition.interaction];
    case "secret":
      return "安全凭据连接";
    case "inherited":
      return `沿用${definition.acquisition.source}授权`;
    case "public":
      return "无需登录";
  }
}
