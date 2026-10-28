import { useCallback, useEffect, useRef, useState } from "react";
import { isReasoningEffort } from "../shared/bridge.ts";
import type { DesktopSnapshot } from "../shared/model.ts";
import { type DesktopProblem, problem } from "../shared/problem.ts";
import { Button, Select } from "./Controls.tsx";
import type { ProductConnection } from "./connection.ts";
import { EffortPicker } from "./EffortPicker.tsx";
import { Glyph } from "./Glyph.tsx";
import { chooseModel } from "./modelPolicy.ts";
import { QueryProblem, readModelCatalog } from "./queries.ts";
import { inlineError } from "./styles.ts";

export function ModelSettings({
  connection,
  snapshot,
  active,
  onBusyChange,
  onDirtyChange,
  edit: controlledEdit,
  change,
}: {
  connection: ProductConnection;
  snapshot: DesktopSnapshot;
  onDirtyChange?(dirty: boolean): void;
  edit?: { model: string; reasoningEffort: string } | null;
  change?(edit: { model: string; reasoningEffort: string } | null): void;
  active: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const available = snapshot.controlReady && snapshot.setup !== "initializing";
  const [catalog, setCatalog] = useState<{
    status: "idle" | "pending" | "success" | "error";
    data: Awaited<ReturnType<typeof readModelCatalog>>;
    error: unknown;
  }>({ status: "idle", data: [], error: null });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const requestedCatalog = useRef(false);
  const catalogRequest = useRef<Promise<void> | null>(null);
  const startCatalogRead = useCallback(() => {
    if (catalogRequest.current) return catalogRequest.current;
    requestedCatalog.current = true;
    setCatalog((previous) => ({
      status: "pending",
      data: previous.data,
      error: null,
    }));
    const request = readModelCatalog(connection)
      .then((data) => {
        if (mounted.current)
          setCatalog({ status: "success", data, error: null });
      })
      .catch((error: unknown) => {
        if (mounted.current)
          setCatalog((previous) => ({
            status: "error",
            data: previous.data,
            error,
          }));
      })
      .finally(() => {
        catalogRequest.current = null;
      });
    catalogRequest.current = request;
    return request;
  }, [connection]);
  const canStartCatalogRead = active && available && snapshot.busy === null;
  useEffect(() => {
    if (!canStartCatalogRead || requestedCatalog.current) return;
    void startCatalogRead();
  }, [canStartCatalogRead, startCatalogRead]);
  const models = catalog.data;
  const loading = catalog.status === "idle" || catalog.status === "pending";
  const catalogProblem =
    catalog.error instanceof QueryProblem ? catalog.error.problem : null;
  const actionInProgress = catalogProblem?.code === "action_in_progress";
  const coordinationStatus =
    snapshot.busy === "selectBot"
      ? "正在切换伙伴…"
      : snapshot.busy !== null && snapshot.busy !== "models"
        ? "等待当前操作完成…"
        : actionInProgress
          ? "当前操作完成后，可重新读取模型。"
          : null;
  const retriedActionInProgress = useRef(false);
  useEffect(() => {
    // A rejected read may race the pushed busy frame. Admit one deferred read
    // for this Bot view; repeated contention leaves an explicit reload action.
    if (
      !canStartCatalogRead ||
      !actionInProgress ||
      retriedActionInProgress.current
    )
      return;
    retriedActionInProgress.current = true;
    requestedCatalog.current = false;
    void startCatalogRead();
  }, [actionInProgress, canStartCatalogRead, startCatalogRead]);
  const refetchCatalog = () => {
    if (!available || snapshot.busy !== null) return;
    requestedCatalog.current = false;
    void startCatalogRead();
  };
  const [localEdit, setLocalEdit] = useState<{
    model: string;
    reasoningEffort: string;
  } | null>(null);
  const edit = controlledEdit === undefined ? localEdit : controlledEdit;
  const setDraft = change ?? setLocalEdit;
  const draft = edit ?? snapshot.policy;
  const [actionError, setError] = useState<DesktopProblem | null>(null),
    [applying, setApplying] = useState(false);
  const [saved, setSaved] = useState(false);
  const current = models.find((entry) => entry.id === snapshot.policy?.model);
  const policyValid = current?.supportedEfforts.some(
    (entry) => entry.id === snapshot.policy?.reasoningEffort,
  );
  const error =
    (actionError?.code === "action_in_progress" ? null : actionError) ??
    (!snapshot.controlReady
      ? (snapshot.problem ?? problem("control_unavailable"))
      : null) ??
    (catalogProblem && !actionInProgress
      ? catalogProblem
      : catalog.error && !actionInProgress
        ? problem("control_unavailable")
        : catalog.status === "success" && !policyValid
          ? problem("model_policy_out_of_sync")
          : null);
  const selected = models.find((item) => item.id === draft?.model);
  const effort = selected?.supportedEfforts.find(
    (item) => item.id === draft?.reasoningEffort,
  );
  const dirty =
    draft &&
    (draft.model !== snapshot.policy?.model ||
      draft.reasoningEffort !== snapshot.policy?.reasoningEffort);
  useEffect(() => {
    onDirtyChange?.(!!dirty);
  }, [dirty, onDirtyChange]);
  const apply = async () => {
    if (
      !draft ||
      !selected ||
      !effort ||
      !isReasoningEffort(draft.reasoningEffort)
    )
      return;
    setApplying(true);
    onBusyChange(true);
    setError(null);
    setSaved(false);
    try {
      const result = await connection.perform({
        type: "updatePolicy",
        policy: { model: draft.model, reasoningEffort: draft.reasoningEffort },
      });
      if (result.ok) {
        setDraft(null);
        setSaved(true);
      } else setError(result.problem);
    } catch {
      setError(problem("control_unavailable"));
    } finally {
      setApplying(false);
      onBusyChange(false);
    }
  };
  const canApply =
    !!dirty &&
    !!effort &&
    !applying &&
    !loading &&
    available &&
    snapshot.account.status === "signedIn" &&
    snapshot.busy === null;
  return (
    <form
      className="@container/settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (canApply) void apply();
      }}
    >
      {error && (
        <p className={inlineError} role="alert">
          {error.title} · {error.message}
        </p>
      )}
      {actionInProgress && (
        <p role="status" className="mb-3 text-sm text-muted">
          {coordinationStatus}
        </p>
      )}
      {catalog.status === "error" && (
        <Button
          disabled={!available || loading || snapshot.busy !== null}
          onClick={refetchCatalog}
        >
          {loading ? "正在读取…" : "重新读取模型"}
        </Button>
      )}
      {loading ? (
        <div className="settings-card settings-note" role="status">
          {!snapshot.controlReady
            ? "连接恢复后，就能读取可用模型。"
            : snapshot.setup === "initializing"
              ? "正在启动…"
              : (coordinationStatus ?? "正在读取可用模型…")}
        </div>
      ) : (
        models.length > 0 && (
          <div className="space-y-5">
            <div className="settings-grid items-center">
              <label htmlFor="model" className="settings-label">
                模型
              </label>
              <Select
                className="settings-value h-9 px-3 text-sm"
                id="model"
                disabled={
                  applying ||
                  snapshot.busy !== null ||
                  !available ||
                  snapshot.account.status !== "signedIn"
                }
                value={draft?.model ?? ""}
                onChange={(event) => {
                  const model = models.find(
                    (item) => item.id === event.target.value,
                  );
                  if (model) {
                    setSaved(false);
                    setDraft(chooseModel(model, draft?.reasoningEffort ?? ""));
                  }
                }}
              >
                {!selected && <option value="">请选择模型</option>}
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="settings-grid items-start">
              <span id="effort-label" className="settings-label pt-2">
                思考深度
              </span>
              <div className="settings-value">
                <EffortPicker
                  key={selected?.id}
                  options={selected?.supportedEfforts ?? []}
                  value={draft?.reasoningEffort}
                  disabled={
                    applying ||
                    snapshot.busy !== null ||
                    !active ||
                    !available ||
                    snapshot.account.status !== "signedIn"
                  }
                  onChange={(reasoningEffort) => {
                    if (draft) {
                      setSaved(false);
                      setDraft({ ...draft, reasoningEffort });
                    }
                  }}
                />
                <p className="settings-note mt-2">
                  深度越高，越适合需要仔细推敲的问题，也可能需要更多等待。
                </p>
              </div>
            </div>
          </div>
        )
      )}
      <div className="settings-grid mt-8 items-center gap-y-1">
        <p
          role="status"
          className="settings-note col-span-4 @max-[560px]/settings:col-span-3"
        >
          {saved && !dirty
            ? "已保存，从下一次任务开始使用。"
            : dirty
              ? "有未保存的修改"
              : catalog.status === "success"
                ? "当前使用的设置"
                : "尚未读取模型"}
        </p>
        <div className="col-span-2 flex items-center justify-end gap-2 @max-[560px]/settings:col-span-3">
          <button
            type="button"
            aria-label="撤销模型修改"
            title="撤销修改"
            disabled={!dirty || applying}
            onClick={() => setDraft(null)}
            className="grid size-8 cursor-pointer place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-ink/5 hover:text-ink disabled:opacity-30 motion-reduce:transition-none control-focus"
          >
            <Glyph name="undo" size={16} />
          </button>
          <Button type="submit" variant="primary" disabled={!canApply}>
            {applying ? "保存中…" : "保存设置"}
          </Button>
        </div>
        <p className="settings-note col-span-6">
          当前任务保持原来的模型与深度。
        </p>
      </div>
    </form>
  );
}
