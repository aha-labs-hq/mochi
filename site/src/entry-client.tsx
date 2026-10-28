import "./site.css";
import type { ComponentType } from "react";

// The header settles onto the page once the reader leaves the first view.
const scrolled = () =>
  document.documentElement.toggleAttribute("data-scrolled", scrollY > 8);
addEventListener("scroll", scrolled, { passive: true });
scrolled();

// The phone menu closes once the reader picks a place or turns elsewhere.
const menu = document.querySelector<HTMLDetailsElement>("[data-menu]");
if (menu) {
  const close = () => {
    menu.open = false;
  };
  menu.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) close();
  });
  document.addEventListener("pointerdown", (event) => {
    if (menu.open && !menu.contains(event.target as Node)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    close();
    menu.querySelector("summary")?.focus();
  });
}

// Sections settle into place once as they enter the reader's view;
// `data-observe` marks scenes that choreograph their own arrival.
const pending = document.querySelectorAll<HTMLElement>(
  "[data-reveal], [data-observe]",
);
if (pending.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          (entry.target as HTMLElement).dataset.shown = "";
          observer.unobserve(entry.target);
        }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
  );
  for (const node of pending) observer.observe(node);
}

// React loads only on pages that have something to interact with. Keep the
// server-rendered story readable and let the browser finish the first view
// before downloading the island that owns its interaction. Each island has
// its own chunk so a page does not pay for the other stories.
const roots = document.querySelectorAll<HTMLElement>("[data-island]");
if (roots.length) {
  // biome-ignore lint/suspicious/noExplicitAny: every island receives its own serialized props.
  type HydratedComponent = ComponentType<any>;
  const loaders: Record<string, () => Promise<HydratedComponent>> = {
    Cast: () => import("./islands/Cast.tsx").then(({ Cast }) => Cast),
    HeroStage: () =>
      import("./islands/HeroStage.tsx").then(({ HeroStage }) => HeroStage),
    RoleStories: () =>
      import("./islands/RoleStories.tsx").then(
        ({ RoleStories }) => RoleStories,
      ),
    StoryScroll: () =>
      import("./islands/StoryScroll.tsx").then(
        ({ StoryScroll }) => StoryScroll,
      ),
    WakingMochi: () =>
      import("./islands/WakingMochi.tsx").then(
        ({ WakingMochi }) => WakingMochi,
      ),
  };

  let started = false;
  const hydrate = () => {
    if (started) return;
    started = true;
    void Promise.all([
      import("react-dom/client"),
      Promise.all(
        Array.from(roots, async (root) => {
          const name = root.dataset.island ?? "";
          const load = loaders[name];
          if (!load) throw new Error(`Unknown island ${name}`);
          return { root, Component: await load() };
        }),
      ),
    ]).then(([{ hydrateRoot }, islands]) => {
      for (const { root, Component } of islands) {
        // biome-ignore lint/suspicious/noExplicitAny: props were serialised from this component.
        const props = JSON.parse(root.dataset.props ?? "{}") as any;
        hydrateRoot(root, <Component {...props} />);
      }
    });
  };

  // A deliberate interaction starts hydration before the next click or key
  // event. The idle timeout is only a safety net for readers who never touch
  // an interactive scene.
  for (const root of roots) {
    root.addEventListener("pointerdown", hydrate, {
      capture: true,
      once: true,
    });
    root.addEventListener("keydown", hydrate, { capture: true, once: true });
  }

  const schedule = () => {
    const idle = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    };
    if (idle.requestIdleCallback)
      idle.requestIdleCallback(hydrate, { timeout: 1500 });
    else window.setTimeout(hydrate, 1500);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
}
