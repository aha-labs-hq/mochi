import account from "./assets/settings/account.png";
import connectors from "./assets/settings/connectors.png";
import diagnostics from "./assets/settings/diagnostics.png";
import feishu from "./assets/settings/feishu.png";
import general from "./assets/settings/general.png";
import github from "./assets/settings/github.png";
import groups from "./assets/settings/groups.png";
import help from "./assets/settings/help.png";
import investigation from "./assets/settings/investigation.png";
import issue from "./assets/settings/issue.png";
import materials from "./assets/settings/materials.png";
import model from "./assets/settings/model.png";
import profile from "./assets/settings/profile.png";
import projects from "./assets/settings/projects.png";
import schedules from "./assets/settings/schedules.svg";
import { cn } from "./styles.ts";

const sources = {
  general,
  connectors,
  feishu,
  github,
  profile,
  model,
  groups,
  projects,
  account,
  diagnostics,
  help,
  investigation,
  issue,
  materials,
  schedules,
};
export type SettingsIconName = keyof typeof sources;

/** Static identities accompany text; controls and real avatars own their symbols. */
export function SettingsIcon({
  name,
  size = 24,
  className,
}: {
  name: SettingsIconName;
  size?: 24 | 36 | 44;
  className?: string;
}) {
  return (
    <img
      src={sources[name]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}
