import { Avatar } from "./Avatar.tsx";
import { Glyph } from "./Glyph.tsx";
import { mailboxIconUrl } from "./mailboxIcon.ts";

export function MailboxAvatar({ address }: { address: string }) {
  return (
    <Avatar
      src={mailboxIconUrl(address)}
      placeholder={<Glyph name="mail" size={20} />}
    />
  );
}
