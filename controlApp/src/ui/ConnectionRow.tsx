import { Glyph } from "./Glyph.tsx";
import { SettingsIcon, type SettingsIconName } from "./SettingsIcon.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";

/** A connection's identity, verified state and next destination stay together. */
export function ConnectionRow({
  title,
  detail,
  action,
  icon,
  onClick,
}: {
  title: string;
  detail: string;
  action: string;
  icon?: SettingsIconName;
  onClick(): void;
}) {
  return (
    <SettingsList>
      <SettingsRow
        leading={icon && <SettingsIcon name={icon} size={36} />}
        title={
          <span title={title} className="block truncate">
            {title}
          </span>
        }
        detail={detail}
        trailing={
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-action">
            {action}
            <Glyph name="chevronRight" size={14} />
          </span>
        }
        action={{
          "data-route-focus": title,
          onClick: (event) => {
            event.currentTarget.focus({ preventScroll: true });
            onClick();
          },
        }}
      />
    </SettingsList>
  );
}
