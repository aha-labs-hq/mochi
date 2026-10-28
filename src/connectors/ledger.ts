/**
 * The connector write ledger: idempotency and provenance in one record.
 *
 * A provider adapter cannot prove it did not already act, so "already applied"
 * is decided here rather than trusted from the adapter. The source message,
 * topic and requester are part of the same row because "was this authorized, by
 * whom, from which message, and has it already happened" is one question with
 * one lifecycle; a separate audit table would duplicate the identity and drift.
 *
 * The ledger is scoped by Bot implicitly: each Bot owns its own state database.
 */
export interface ConnectorWriteRecord {
  connectionId: string;
  capabilityId: string;
  idempotencyKey: string;
  resourceId: string;
  catalogRevision: string;
  capabilityRevision: string;
  /**
   * A digest of the exact input. A key reused with different input is a
   * different request and must not be answered with the earlier result, so the
   * input is part of the fingerprint rather than assumed to match the key.
   */
  inputDigest: string;
  status: ConnectorWriteStatus;
  sourceMessageId: string;
  topicKey: string;
  requesterId: string;
  /** The authorization quote is never stored as prose; only its digest is kept. */
  authorizationDigest: string | null;
  resultJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ConnectorWriteStatus = "pending" | "applied";

/**
 * Bounded per connection by count, evicting the oldest applied rows.
 *
 * There is no honest TTL: a replay can arrive arbitrarily late, and expiring a
 * key turns a duplicate write into a second real side effect, which is strictly
 * worse than a slightly stale readback. Pending rows are never evicted.
 */
export const CONNECTOR_MAX_WRITE_RECORDS_PER_CONNECTION = 10_000;

export interface ConnectorWriteStore {
  connectorWriteRecord(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ): ConnectorWriteRecord | undefined;
  /** Atomically claims a key. False means another writer already holds it. */
  claimConnectorWrite(
    record: Omit<ConnectorWriteRecord, "status" | "resultJson">,
  ): boolean;
  /** Marks a claimed key applied and stores the authoritative readback. */
  completeConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
    resultJson: string,
  ): void;
  /**
   * Releases a claim after the adapter failed, so a legitimate retry can
   * proceed. Only a completed write may block a later attempt.
   */
  abandonConnectorWrite(
    connectionId: string,
    capabilityId: string,
    idempotencyKey: string,
  ): void;
}
