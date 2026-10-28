import type { SettingsRoute } from "../shared/settings.ts";
import { SUPPORT_EMAIL } from "../shared/support.ts";
import { Button } from "./Controls.tsx";
import { MethodList } from "./Methods.tsx";

/** Shipped, offline help. It names only the published support mailbox and exposes no private repository. */
export function HelpSettings({
  navigate,
}: {
  navigate(route: SettingsRoute): void;
}) {
  return (
    <div className="space-y-10 text-sm leading-6 [&_section>ol]:max-w-[42em] [&_section>p]:max-w-[42em] [&_section>h2]:settings-section-title [&_section>p]:mt-1 [&_section>button]:mt-3 [&>section:has(>h2)]:border-t [&>section:has(>h2)]:border-hairline [&>section:has(>h2)]:pt-3 [&_section>h2]:mb-2">
      <section>
        <h2>第一次一起工作</h2>
        <ol className="mt-1 list-decimal space-y-2 pl-5 marker:text-muted marker:tabular-nums">
          <li>
            在应用的“模型连接”中连接自己的 ChatGPT 订阅，或添加一个模型 API
            连接。API 地址、模型名称和连接名称都可以直接填写。
          </li>
          <li>
            用飞书或 Lark
            扫码连接机器人，核对名称后确认使用。需要额外授权时，Mochi
            会带你到已选好权限的对应的官方页面；需要管理员批准时，把权限链接发给管理员，批准后
            Mochi
            会自动继续。群里分享的文档链接会在那条消息里读取，不用为每份文档重新登录。
          </li>
          <li>
            连接
            GitHub，选择并保存希望这位伙伴了解的项目。组织项目可能需要管理员同意。
          </li>
          <li>
            连接完成后，打开伙伴名字旁的开关开始值班。在群设置里添加这个机器人，然后在群里输入
            @，选中它并发送问题。同一话题里可以直接接着说。
          </li>
        </ol>
      </section>
      <section>
        <h2>伙伴什么时候在值班？</h2>
        <p>
          Mac 需要开机、保持唤醒并连接网络，Mochi
          也需要在运行。关闭窗口后，伙伴们继续值班；选择“退出”会结束所有伙伴在这台
          Mac
          上的值班。睡眠或离线期间不能保证接收消息，恢复后请重新发送还没得到回应的问题。
        </p>
      </section>
      <section>
        <h2>群里没有回应</h2>
        <p>
          先确认群聊机器人已加入这个群、群的“回应”已开启；新话题需要真正 @
          它。再检查群聊连接和模型连接。ChatGPT
          订阅额度用尽时，需要等额度恢复；模型 API
          服务的额度和状态由对应服务负责。
        </p>
        <Button size="small" onClick={() => navigate({ page: "groups" })}>
          检查群聊
        </Button>
      </section>
      <section>
        <h2>项目找不到，或暂时不能访问</h2>
        <p>
          先在 GitHub 为 Mochi
          授权指定项目，再回到“项目与访问”勾选并保存，新授权的项目会自动出现。身份登录成功不代表已获得项目访问权限；组织授权可能仍在等待管理员批准。
        </p>
        <Button size="small" onClick={() => navigate({ page: "projects" })}>
          查看项目与访问
        </Button>
      </section>
      <section>
        <h2>记忆与访问范围</h2>
        <p>
          同一位伙伴开启的群共用它的长期记忆，就像同一位同事在几个群里；涉及其他群的私下讨论时，会先判断是否适合在当前群转述。不同伙伴的记忆、群聊连接和项目访问相互独立，模型连接由这台
          Mac
          共用。新加入的群默认开启回应，只把适合共享背景的群接进来。项目读取仅限你的选择；文档和知识库按平台里的分享关系读取，读不到的部分会明确说明；Issue
          修改会绑定当前消息中的明确请求；信息不足时，伙伴会先追问，不会凭空执行，不会修改代码、PR
          或工作流。暂停群、退出 App 或更换账号不会清空已有工作记录。
        </p>
      </section>
      <section>
        <h2>为什么界面一直是浅色？</h2>
        <p>
          Mochi 的窗口固定使用暖白的浅色纸面，即使 macOS
          处于深色模式。这是有意的选择：毛毡角色和文字在浅色纸面上最清楚，各个窗口也保持同一种观感。夜间使用时，可以调低屏幕亮度。
        </p>
      </section>
      <MethodList
        title="工作方法原文"
        ids={[
          "github-investigation",
          "issue-authoring",
          "feishu-collaboration",
          "message-contract",
        ]}
        navigate={(id) => navigate({ page: "document", id, section: "help" })}
      />
      <section>
        <h2>遇到其他问题</h2>
        <p>
          在运行诊断中检查连接、恢复后台或导出诊断文件。需要帮助时，把诊断文件发送到{" "}
          <span className="text-ink select-text">{SUPPORT_EMAIL}</span>
          ，并说明出问题的步骤和发生时间。诊断导出不包含聊天正文、账号凭据或项目目录。
        </p>
        <Button size="small" onClick={() => navigate({ page: "diagnostics" })}>
          打开运行诊断
        </Button>
      </section>
    </div>
  );
}
