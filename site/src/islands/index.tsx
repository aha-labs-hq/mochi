import type { ComponentType } from "react";
import { Cast } from "./Cast.tsx";
import { HeroStage } from "./HeroStage.tsx";
import { RoleStories } from "./RoleStories.tsx";
import { StoryScroll } from "./StoryScroll.tsx";
import { WakingMochi } from "./WakingMochi.tsx";

/** Interactive parts of otherwise static pages, hydrated by name. */
export const islands = {
  Cast,
  HeroStage,
  RoleStories,
  StoryScroll,
  WakingMochi,
};
export type IslandName = keyof typeof islands;

/**
 * Renders an island on the server with the props its browser half needs.
 * `display: contents` keeps the wrapper out of the page's layout.
 */
function island<Props extends object>(
  name: IslandName,
  Component: ComponentType<Props>,
) {
  return function Island(props: Props) {
    return (
      <div
        data-island={name}
        data-props={JSON.stringify(props)}
        className="contents"
      >
        <Component {...props} />
      </div>
    );
  };
}

export const Island = {
  HeroStage: island("HeroStage", HeroStage),
  RoleStories: island("RoleStories", RoleStories),
  StoryScroll: island("StoryScroll", StoryScroll),
  Cast: island("Cast", Cast),
  WakingMochi: island("WakingMochi", WakingMochi),
};
