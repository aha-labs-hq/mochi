export type UpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "current"
  | "withdrawn"
  | "available"
  | "downloading"
  | "paused"
  | "ready"
  | "preparing"
  | "waiting"
  | "closing"
  | "installing"
  | "verifying"
  | "restoring"
  | "completed"
  | "restored"
  | "failed";
export interface UpdatePreferences {
  check: boolean;
  download: boolean;
  install: boolean;
}
export interface UpdateView {
  phase: UpdatePhase;
  target: string | null;
  notes: string;
  received: number;
  total: number;
  checkedAt: string | null;
  error:
    | "network"
    | "verification"
    | "storage"
    | "permission"
    | "installation"
    | "recovery"
    | null;
  preferences: UpdatePreferences;
}
export const initialUpdateView = (): UpdateView => ({
  phase: "unavailable",
  target: null,
  notes: "",
  received: 0,
  total: 0,
  checkedAt: null,
  error: null,
  preferences: { check: true, download: true, install: false },
});
