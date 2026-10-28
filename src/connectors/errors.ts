export type ConnectorErrorCode =
  | "request_invalid"
  | "catalog_changed"
  | "connection_not_found"
  | "connection_unavailable"
  | "resource_unavailable"
  | "resource_not_selected"
  | "capability_unavailable"
  | "capability_wrong_operation"
  | "input_invalid"
  | "authorization_missing"
  | "authorization_too_short"
  | "authorization_target_mismatch"
  | "write_budget_exhausted"
  | "idempotency_invalid"
  | "idempotency_conflict"
  | "idempotency_in_flight"
  | "idempotency_unavailable"
  | "adapter_failed"
  | "adapter_result_invalid"
  | "readback_missing"
  | "provider_unavailable"
  | "provider_request_failed"
  | "provider_response_invalid"
  | "metadata_incomplete"
  | "not_readable";

/**
 * A provider's own reason for refusing one request.
 *
 * The provider adapter reduces it to bounded, credential-free fields before it
 * reaches this type, so it is data the caller can act on — which field the
 * provider rejected and why — and never the provider's raw response body.
 */
export interface ConnectorProviderReason {
  readonly status: number;
  readonly code: string;
  readonly message?: string;
  readonly errors?: readonly ConnectorProviderFieldError[];
}

export interface ConnectorProviderFieldError {
  readonly resource?: string;
  readonly field?: string;
  readonly code?: string;
  readonly message?: string;
}

/** Stable boundary error; callers must branch on code rather than prose. */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  /** The request path the caller must correct, such as `input.issue_number`. */
  readonly field: string | undefined;
  readonly provider: ConnectorProviderReason | undefined;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      field?: string;
      provider?: ConnectorProviderReason;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ConnectorError";
    this.code = code;
    this.field = options?.field;
    this.provider = options?.provider;
  }
}
