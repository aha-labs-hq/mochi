import { isGitHubId } from "../shared/bridge.ts";
import { Avatar } from "./Avatar.tsx";
import { Glyph } from "./Glyph.tsx";

/** GitHub's public avatar endpoint, addressed by the catalog's verified owner ID. */
export function GitHubOwnerAvatar({
  ownerId,
  small = false,
}: {
  ownerId: number;
  small?: boolean;
}) {
  return (
    <Avatar
      src={
        isGitHubId(ownerId)
          ? `https://avatars.githubusercontent.com/u/${ownerId}?s=80&v=4`
          : null
      }
      small={small}
      placeholder={<Glyph name="folder" className="size-3/5" />}
    />
  );
}
