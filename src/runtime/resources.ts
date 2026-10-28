import { createExtensionRuntime, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** Pi may reload this explicit prompt, but never discovers ambient resources. */
export function isolatedResourceLoader(systemPrompt: () => string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

/**
 * The one focus Pi adds to its summary prompt when Mochi's permanent Session is
 * compacted, automatically or on request. One Bot keeps one memory across its
 * groups, so the summary must keep where each fact came from; otherwise the
 * cross-group discretion rule has nothing to work with after compaction.
 */
export const SESSION_COMPACTION_INSTRUCTIONS = `这是飞书多群工作会话的摘要，它会替代原始记录。同一个 Bot 同时在几个群里，除上面的格式外还要做到：
- 每条重要事实、决定、承诺和待办都写明出处【群名 · 话题 · 发言人】，能确定时间就带上；话题用起始消息的简短描述指代。不确定的部分写“未知”，不要猜，也不要把不同群的内容合并成一条。
- 在各节内按群分组；同一件事在几个群都出现时，分别注明。
- 个人情况、人事、薪酬、对人的评价、明确说过“别外传”的内容，以及只适合某个群的私下讨论，保留在原群名下并标注〔私下〕。
- 项目事实优先记下共享来源（GitHub Issue、PR 的编号或链接），以后引用来源，而不是转述谁在哪个群说过。
- 保留长期决定、未完成的承诺和安排、需要人决定的事项，以及它们所在的群和话题；删除重复过程、工具输出细节和已经过时的推理。`;

/** In-memory settings for a Mochi-owned Session: no ambient files, retries or telemetry. */
export function isolatedSettings(compaction: boolean): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: compaction, customInstructions: SESSION_COMPACTION_INSTRUCTIONS },
    retry: { enabled: false },
    defaultProjectTrust: "never",
    enableAnalytics: false,
    enableInstallTelemetry: false,
  });
}
