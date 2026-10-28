import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type InstructionDocument,
  MAXIMUM_INSTRUCTION_CHARACTERS,
  parseInstructionDocument,
} from "../shared/bridge.ts";
import { type DesktopProblem, projectFailure } from "../shared/problem.ts";
import { Button } from "./Controls.tsx";
import type { ProductConnection } from "./connection.ts";
import { Glyph } from "./Glyph.tsx";
import { MarkdownDocument } from "./MarkdownDocument.tsx";

export interface InstructionDraft {
  base: InstructionDocument;
  content: string;
}

export function InstructionsSettings({
  botName,
  active,
  available,
  busy,
  connection,
  draft,
  change,
  onBusyChange,
  introduction,
}: {
  botName: string;
  active: boolean;
  available: boolean;
  busy: boolean;
  connection: ProductConnection;
  draft: InstructionDraft | null;
  change(draft: InstructionDraft): void;
  onBusyChange(busy: boolean): void;
  introduction: ReactNode;
}) {
  const [failure, setFailure] = useState<DesktopProblem | null>(null);
  const [latest, setLatest] = useState<InstructionDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // The draft is Markdown; a reading view shows what its marks mean without a
  // second editor. Editing always happens in the plain text.
  const [previewing, setPreviewing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = draft !== null && draft.content !== draft.base.content;
  let valid = false;
  if (draft) {
    try {
      parseInstructionDocument({ ...draft.base, content: draft.content });
      valid = true;
    } catch {
      /* Validation is shown beside the editor. */
    }
  }
  const canSave =
    active &&
    available &&
    !busy &&
    !loading &&
    dirty &&
    valid &&
    failure?.code !== "instructions_conflict";

  async function read(review = false) {
    setLoading(true);
    try {
      const result = await connection.instructions({ type: "read" });
      if (!mounted.current) return;
      if (!result.ok) {
        setFailure(result.problem);
        return;
      }
      if (review) setLatest(result.value);
      else {
        change({ base: result.value, content: result.value.content });
        setFailure(null);
      }
    } catch (error) {
      if (mounted.current)
        setFailure(projectFailure(error, "control_unavailable"));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  // Read only on first visit. Reconnection and tab switches never overwrite a draft.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (active && available && !draft && !failure && !loading)
      void readRef.current();
  }, [active, available, draft, failure, loading]);

  async function save() {
    if (!draft || !canSave) return;
    setSaving(true);
    onBusyChange(true);
    try {
      const result = await connection.instructions({
        type: "save",
        document: { ...draft.base, content: draft.content },
      });
      if (!mounted.current) return;
      if (!result.ok) {
        setFailure(result.problem);
        return;
      }
      change({ base: result.value, content: result.value.content });
      setFailure(null);
      setLatest(null);
    } catch (error) {
      if (mounted.current)
        setFailure(projectFailure(error, "control_unavailable"));
    } finally {
      if (mounted.current) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-settings-scroll className="settings-scroll min-h-0 flex-1">
        <div className="settings-content @container/settings flex min-h-full flex-col pb-1">
          <div className="shrink-0">{introduction}</div>
          <form
            id="instructions-form"
            data-settings-primary
            className="flex min-h-64 shrink-0 flex-1 flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="settings-grid shrink-0 items-baseline border-t border-hairline pt-3">
              <h2 className="settings-section-title col-span-1 @max-[560px]/settings:col-span-2">
                <label htmlFor="mochi-instructions">嘱咐</label>
              </h2>
              <p
                id="instructions-help"
                className="col-span-5 text-xs leading-6 text-muted [overflow-wrap:anywhere] @max-[560px]/settings:col-span-4"
              >
                <span>写下你希望它怎样一起工作，</span>
                <span>
                  {available
                    ? "从下一次任务开始使用。"
                    : "等待后台连接，草稿会留在这里。"}
                </span>
                <span>## 开头的行是小标题。</span>
              </p>
            </div>
            <div className="flex min-h-52 flex-1 flex-col overflow-hidden rounded-md border border-field-border bg-field has-focus-visible:focus-ring">
              {draft && previewing ? (
                <div
                  role="document"
                  aria-label={`给${botName}的嘱咐预览`}
                  className="settings-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 text-base leading-6 select-text"
                >
                  <MarkdownDocument
                    content={draft.content}
                    navigate={() => {}}
                  />
                </div>
              ) : draft ? (
                <textarea
                  id="mochi-instructions"
                  aria-label={`给${botName}的嘱咐`}
                  aria-describedby="instructions-help"
                  aria-invalid={!valid}
                  spellCheck={false}
                  value={draft.content}
                  readOnly={busy}
                  onChange={(event) =>
                    change({ ...draft, content: event.target.value })
                  }
                  className="settings-scrollbar min-h-0 w-full flex-1 resize-none overscroll-contain bg-transparent p-4 text-base leading-6 text-ink outline-none selection:bg-primary/20 disabled:opacity-60"
                />
              ) : (
                <div className="flex min-h-32 flex-1 items-center justify-center px-6 py-8 text-center text-sm leading-relaxed text-muted">
                  {loading
                    ? "正在读取嘱咐…"
                    : available
                      ? "还没有读到嘱咐。"
                      : "后台连接后，就能查看和修改嘱咐。"}
                </div>
              )}
            </div>
            {draft && !valid && (
              <p
                role="alert"
                className="shrink-0 text-sm leading-relaxed text-error"
              >
                请保留至少一句嘱咐，不使用特殊控制字符，且不超过{" "}
                {MAXIMUM_INSTRUCTION_CHARACTERS.toLocaleString()} 个字符。
              </p>
            )}
            {failure && (
              <div
                role="alert"
                className="shrink-0 space-y-2 text-sm leading-relaxed"
              >
                <p className="text-error">
                  {failure.title}。{failure.message}
                </p>
                {failure.code === "instructions_conflict" ? (
                  <Button
                    disabled={busy || loading || !available}
                    onClick={() => void read(true)}
                  >
                    查看最新内容
                  </Button>
                ) : (
                  <Button
                    disabled={
                      busy || loading || !available || (!!draft && !canSave)
                    }
                    onClick={() => void (draft ? save() : read())}
                  >
                    再试一次
                  </Button>
                )}
              </div>
            )}
            {latest && (
              <div className="shrink-0 space-y-3 rounded-xl border border-hairline p-4">
                <details open>
                  <summary className="cursor-pointer text-sm font-semibold">
                    另一处保存的内容
                  </summary>
                  <pre className="mt-3 max-h-40 select-text overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
                    {latest.content}
                  </pre>
                </details>
                <p className="text-xs leading-relaxed text-muted">
                  先把需要保留的内容合进上面的草稿。继续后，下次保存将以你的草稿为准。
                </p>
                <Button
                  onClick={() => {
                    if (draft) change({ base: latest, content: draft.content });
                    setLatest(null);
                    setFailure(null);
                  }}
                >
                  已核对，继续编辑草稿
                </Button>
              </div>
            )}
          </form>
        </div>
      </div>
      <footer className="settings-content @container/settings shrink-0">
        <div className="settings-grid items-center gap-y-1 pt-1 pb-4">
          <div className="col-span-4 min-w-0 @max-[560px]/settings:col-span-3">
            <p
              role="status"
              className="flex min-h-9 flex-wrap items-center gap-x-3 text-xs leading-5"
            >
              {saving
                ? "正在保存…"
                : failure
                  ? "尚未保存"
                  : dirty
                    ? "有未保存的修改"
                    : draft
                      ? "嘱咐已保存"
                      : "尚未读取"}
              {draft && (
                <span className="text-muted">
                  {draft.content.length.toLocaleString()} 字
                </span>
              )}
            </p>
          </div>
          <div className="col-span-2 flex items-center justify-end gap-2 @max-[560px]/settings:col-span-3">
            <Button
              variant="text"
              size="small"
              aria-pressed={previewing}
              disabled={!draft}
              onClick={() => setPreviewing(!previewing)}
              className="m-0 h-9 shrink-0 px-2 text-muted aria-pressed:text-ink"
            >
              {previewing ? "编辑" : "预览"}
            </Button>
            <button
              type="button"
              aria-label="撤销嘱咐修改"
              title="撤销修改"
              disabled={!dirty || busy}
              onClick={() => {
                if (draft)
                  change({ base: draft.base, content: draft.base.content });
              }}
              className="grid size-8 cursor-pointer place-items-center rounded-sm text-muted transition-colors duration-150 hover:bg-ink/5 hover:text-ink disabled:opacity-30 motion-reduce:transition-none control-focus"
            >
              <Glyph name="undo" size={16} />
            </button>
            <Button
              type="submit"
              form="instructions-form"
              variant="primary"
              aria-label="保存嘱咐"
              aria-keyshortcuts="Meta+S Control+S"
              disabled={!canSave}
              className="h-9 shrink-0 px-4"
            >
              保存嘱咐
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
