import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import publication from "../../site/publication.json";
import { initialSnapshot } from "../src/shared/model.ts";
import { problem } from "../src/shared/problem.ts";
import { SUPPORT_EMAIL } from "../src/shared/support.ts";
import { DiagnosticsSettings } from "../src/ui/DiagnosticsSettings.tsx";
import { HelpSettings } from "../src/ui/HelpSettings.tsx";

test("diagnostics and help name the published support mailbox, never a raw problem code", () => {
  expect(`mailto:${SUPPORT_EMAIL}`).toBe(publication.supportUrl);
  const timeout = problem("service_readiness_timeout");
  expect(timeout.message).toContain(SUPPORT_EMAIL);
  const diagnostics = renderToStaticMarkup(
    <DiagnosticsSettings
      snapshot={{ ...initialSnapshot("0.3.0", true), problem: timeout }}
      act={async () => {}}
    />,
  );
  expect(diagnostics).toContain(SUPPORT_EMAIL);
  expect(diagnostics).toContain(timeout.title);
  expect(diagnostics).not.toContain(timeout.code);
  expect(renderToStaticMarkup(<HelpSettings navigate={() => {}} />)).toContain(
    SUPPORT_EMAIL,
  );
});
