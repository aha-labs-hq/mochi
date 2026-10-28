import { useQuery } from "@tanstack/react-query";
import { type RefObject, useLayoutEffect } from "react";
import { BUILTIN_SKILLS, type SkillId } from "../shared/bridge.ts";
import { Button } from "./Controls.tsx";
import type { ProductConnection } from "./connection.ts";
import { Glyph } from "./Glyph.tsx";
import { MarkdownDocument } from "./MarkdownDocument.tsx";
import { QueryProblem, skillCatalogQuery } from "./queries.ts";
import { SettingsIcon, type SettingsIconName } from "./SettingsIcon.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";

export const methodIcons = {
  "github-investigation": "investigation",
  "issue-authoring": "issue",
  "message-contract": "materials",
  "feishu-collaboration": "groups",
} satisfies Record<SkillId, SettingsIconName>;
const descriptions = {
  "github-investigation": "从线索找到相关代码与证据。",
  "issue-authoring": "把讨论整理成清楚、可执行的 Issue。",
  "message-contract": "怎样读取消息、图片和附件，遇到缺失怎样说明。",
  "feishu-collaboration": "参与群聊时的分寸与协作方式。",
} satisfies Record<SkillId, string>;
/**
 * What each method means for the people in the group, in three points. The
 * protocol itself is written for the model; it stays one tab away, unedited.
 */
const summaries = {
  "github-investigation": [
    "回答项目问题前，先查团队选定的 GitHub 项目里相关的 Issue、PR 和代码。",
    "说清哪些已经确认、哪些还缺证据；代码合并不等于已经上线，也不编造进展。",
    "附上能核对的 Issue 或 PR 链接。代码只读，不会被修改。",
  ],
  "issue-authoring": [
    "把群里的讨论整理成清楚的 Issue：要解决的问题、期望的变化和已知约束。",
    "只记录大家确认过的决定和负责人，不替团队拍板。",
    "能在原来的 Issue 上更新就不重复新建；回帖只说实际做成了什么。",
  ],
  "feishu-collaboration": [
    "在群里 @ 它，或在它已经参与的话题里接着说，它才会回应。",
    "像熟悉项目的同事一样，先给结论，再给关键依据。",
    "群里其他消息只帮它理解背景，不会被当成任何人的授权。",
  ],
  "message-contract": [
    "会看消息里的图片、文件和飞书文档链接。",
    "读不了或读不全的材料会直说，不假装看过。",
    "材料只在这次回答里使用，不会另存一份。",
  ],
} satisfies Record<SkillId, readonly [string, string, string]>;
export function MethodList({
  title,
  ids,
  navigate,
}: {
  title: string;
  ids: readonly SkillId[];
  navigate(id: SkillId): void;
}) {
  return (
    <section className="mt-10">
      <SettingsSectionHeader title={title} />
      <SettingsList>
        {ids.map((id) => (
          <SettingsRow
            key={id}
            leading={<SettingsIcon name={methodIcons[id]} size={36} />}
            title={BUILTIN_SKILLS.find((skill) => skill.id === id)?.name}
            detail={descriptions[id]}
            trailing={
              <Glyph name="chevronRight" size={14} className="text-muted" />
            }
            action={{
              "data-route-focus": id,
              onClick: (event) => {
                event.currentTarget.focus({ preventScroll: true });
                navigate(id);
              },
            }}
          />
        ))}
      </SettingsList>
    </section>
  );
}
export interface MethodReadingState {
  source: boolean;
  readingScroll: number;
  sourceScroll: number;
}

export function MethodReader({
  id,
  connection,
  available,
  busy,
  scrollContainer,
  reading,
  changeReading,
  navigate,
}: {
  id: SkillId;
  connection: ProductConnection;
  available: boolean;
  busy: boolean;
  scrollContainer: RefObject<HTMLElement | null>;
  reading: MethodReadingState;
  changeReading(state: MethodReadingState): void;
  navigate(id: SkillId): void;
}) {
  const query = useQuery({
    ...skillCatalogQuery(connection),
    enabled: available,
  });
  const { source } = reading;
  const setSource = (next: boolean) => {
    if (source === next) return;
    changeReading({
      ...reading,
      source: next,
      [source ? "sourceScroll" : "readingScroll"]:
        scrollContainer.current?.scrollTop ?? 0,
    });
  };
  useLayoutEffect(() => {
    if (scrollContainer.current)
      scrollContainer.current.scrollTop = source
        ? reading.sourceScroll
        : reading.readingScroll;
  }, [source, reading.sourceScroll, reading.readingScroll, scrollContainer]);
  const document = query.data?.find((item) => item.id === id);
  if (!available || !document)
    return (
      <div className="space-y-4 py-12 text-center text-sm text-muted">
        <p role={query.isError ? "alert" : "status"}>
          {!available
            ? "后台连接后，就能查看工作方法。"
            : query.isError
              ? query.error instanceof QueryProblem
                ? `${query.error.problem.title}。${query.error.problem.message}`
                : "暂时无法读取工作方法。"
              : "正在读取工作方法…"}
        </p>
        {available && query.isError && (
          <Button
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            重新读取
          </Button>
        )}
      </div>
    );
  return (
    <article aria-label={document.name}>
      <header className="settings-grid mb-8 items-center gap-y-2 border-b border-hairline pb-5">
        <div className="col-span-4 min-w-0 @max-[560px]/settings:col-span-3">
          {/* The summary view's title; the protocol's own heading titles 原文. */}
          {source ? (
            <p className="text-sm leading-5 font-semibold">{document.name}</p>
          ) : (
            <h1
              tabIndex={-1}
              className="text-sm leading-5 font-semibold tracking-normal outline-none"
            >
              {document.name}
            </h1>
          )}
          <p className="text-xs leading-5 text-muted">
            <span>{descriptions[id]}</span>
            <span>伙伴们遵循的工作方法 · 只读</span>
          </p>
        </div>
        <fieldset
          aria-label="阅读方式"
          className="col-span-2 flex justify-self-end rounded-md bg-ink/5 p-0.5 @max-[560px]/settings:col-span-3"
        >
          {[false, true].map((value) => (
            <button
              type="button"
              key={String(value)}
              aria-pressed={source === value}
              onClick={() => setSource(value)}
              className="min-h-7 cursor-pointer rounded-[5px] px-3 text-xs text-muted transition-colors duration-150 hover:text-ink aria-pressed:bg-card aria-pressed:text-ink aria-pressed:shadow-control motion-reduce:transition-none control-focus"
            >
              {value ? "原文" : "要点"}
            </button>
          ))}
        </fieldset>
      </header>
      {source ? (
        <MarkdownDocument content={document.content} navigate={navigate} />
      ) : (
        <ol className="max-w-[42em] list-none space-y-4 p-0 text-base leading-7">
          {summaries[id].map((point, index) => (
            <li key={point} className="grid grid-cols-[24px_minmax(0,1fr)]">
              <span
                aria-hidden
                className="text-sm leading-7 text-muted tabular-nums"
              >
                {index + 1}
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
