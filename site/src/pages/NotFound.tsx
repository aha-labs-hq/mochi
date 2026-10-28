import { Shell } from "../layout.tsx";
import { art } from "../media.ts";
import { Action, Picture } from "../ui.tsx";

export function NotFound() {
  return (
    <Shell>
      <section className="site-container flex flex-col items-center py-24 text-center md:py-32">
        <div className="w-[180px] border-b border-hairline">
          <Picture
            picture={art.sleeping}
            alt="趴着打盹的麻薯"
            sizes="180px"
            className="-mb-[7%] h-auto w-full"
          />
        </div>
        <h1 className="mt-10 text-[28px] leading-9 font-semibold">
          这一页不存在
        </h1>
        <p className="mt-3 text-muted">
          链接可能已经变了。回到首页看看麻薯能做什么。
        </p>
        <div className="mt-10">
          <Action href="/">回到首页</Action>
        </div>
      </section>
    </Shell>
  );
}
