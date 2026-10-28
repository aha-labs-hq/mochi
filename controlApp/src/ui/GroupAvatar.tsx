import type { FeishuGroup } from "../../../src/lark/group.ts";
import { Avatar } from "./Avatar.tsx";
import { Glyph } from "./Glyph.tsx";

export function GroupAvatar({
  group,
  small = false,
}: {
  group: Pick<FeishuGroup, "avatarUrl">;
  small?: boolean;
}) {
  return (
    <Avatar
      src={group.avatarUrl}
      small={small}
      placeholder={<Glyph name="people" className="size-1/2" />}
    />
  );
}
