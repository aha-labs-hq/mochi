import manifest from "../../../motion/manifest.json";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { cn } from "./styles.ts";

export function BotIdentitySettings({
  snapshot,
  busy,
  act,
  nameDraft,
  changeName,
}: {
  snapshot: DesktopSnapshot;
  busy: boolean;
  act(action: DesktopAction): Promise<void>;
  nameDraft: string | undefined;
  changeName(value: string): void;
}) {
  const bot = snapshot.bots.find(
    (entry) => entry.botId === snapshot.selectedBotId,
  );
  if (!bot) return null;
  const name = nameDraft ?? bot.label;
  const canRename =
    !busy &&
    snapshot.controlReady &&
    !!name.trim() &&
    name.trim() !== bot.label;
  // Form groups open on the same rule as every section; their row labels in
  // the label column are the headings.
  return (
    <section
      aria-label="伙伴身份"
      className="mb-8 shrink-0 space-y-3 border-t border-hairline pt-3"
    >
      <form
        className="settings-grid items-center"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRename)
            void act({
              type: "renameBot",
              botId: bot.botId,
              label: name.trim(),
            });
        }}
      >
        <div className="settings-label">
          <label htmlFor="bot-name">名字</label>
          {name !== bot.label && (
            <p className="text-2xs leading-4 text-status-attention">
              名字未保存
            </p>
          )}
        </div>
        <input
          id="bot-name"
          aria-label="伙伴的名字"
          maxLength={60}
          value={name}
          onChange={(event) => changeName(event.target.value)}
          className="col-span-4 h-9 min-w-0 rounded-md border border-field-border bg-field px-3 text-sm field-focus @max-[560px]/settings:col-span-2 max-[399px]:px-2"
        />
        <Button
          type="submit"
          aria-label="保存名字"
          disabled={!canRename}
          className="h-9 min-h-9 min-w-0 px-3 py-0 @max-[560px]/settings:col-span-2 max-[399px]:px-2"
        >
          更名
        </Button>
      </form>
      {manifest.characters.length > 1 && (
        <fieldset
          aria-labelledby="character-choice-title"
          className="settings-grid min-w-0 items-center gap-y-2 border-0 p-0"
        >
          <legend id="character-choice-title" className="sr-only">
            角色形象
          </legend>
          <span
            aria-hidden
            className="settings-label @max-[420px]/settings:col-span-6"
          >
            形象
          </span>
          <p id="character-choice-help" className="sr-only">
            只改变陪伴你的样子，不改变连接、记忆、模型或工作范围。
          </p>
          <div
            data-testid="character-choice-list"
            className="settings-value grid grid-cols-3 gap-2 @max-[420px]/settings:col-span-6"
          >
            {manifest.characters.map((character) => {
              const root = character.assets.find(
                (asset) => asset.id === character.rootAsset,
              );
              if (!root) return null;
              const selected = bot.characterId === character.id;
              const { canvasWidth, canvasHeight, visualBounds } = root.geometry;
              return (
                <label
                  key={character.id}
                  data-checked={selected}
                  title={`${character.displayName} · ${character.selection.tagline} · ${character.selection.detail}`}
                  className={cn(
                    "group relative flex min-h-12 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border px-2 py-1.5 transition-colors duration-150 hover:bg-card has-focus-visible:focus-ring motion-reduce:transition-none @max-[560px]/settings:flex-col @max-[560px]/settings:gap-1",
                    selected
                      ? "border-ink/25 bg-card shadow-control"
                      : "border-hairline bg-card/40",
                  )}
                >
                  <input
                    type="radio"
                    name="bot-character"
                    value={character.id}
                    checked={selected}
                    disabled={busy || !snapshot.controlReady}
                    aria-label={`${character.displayName}：${character.selection.detail}`}
                    aria-describedby="character-choice-help"
                    onChange={() =>
                      void act({
                        type: "setBotCharacter",
                        botId: bot.botId,
                        characterId: character.id,
                      })
                    }
                    className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
                  />
                  <span className="relative block size-8 shrink-0 overflow-hidden">
                    <img
                      src={`./assets/${root.resource}.png`}
                      alt=""
                      className="absolute left-1/2 max-w-none"
                      style={{
                        // The manifest's visible silhouette owns optical size and baseline.
                        height: `${(canvasHeight / visualBounds.height) * 100}%`,
                        bottom: `${-((canvasHeight - visualBounds.y - visualBounds.height) / visualBounds.height) * 100}%`,
                        transform: `translateX(-${((visualBounds.x + visualBounds.width / 2) / canvasWidth) * 100}%)`,
                      }}
                    />
                  </span>
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1 text-sm leading-5",
                      selected ? "font-medium text-ink" : "text-muted",
                    )}
                  >
                    <span className="truncate">{character.displayName}</span>
                    <Glyph
                      name="check"
                      size={12}
                      className={cn(
                        "text-ink opacity-0",
                        selected && "opacity-100",
                      )}
                    />
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </section>
  );
}
