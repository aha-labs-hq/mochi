/* One collection owner. no-transform prevents an unconditional Cloudflare beacon. */
(() => {
  const hostname = "mochi.host";
  const token = "10c17d7290c54d59966030e06de94da1";
  const ahrefsKey = "zw5uM+7j40MRJ10EoBt9wg";
  if (location.hostname !== hostname || navigator.webdriver) return;
  if (
    document.querySelector('meta[name="robots"]')?.content.includes("noindex")
  )
    return;

  const script = (src) => {
    const element = document.createElement("script");
    element.src = src;
    element.async = true;
    return element;
  };
  const beacon = script("https://static.cloudflareinsights.com/beacon.min.js");
  beacon.dataset.cfBeacon = JSON.stringify({ token });
  document.head.append(beacon);

  // Public page path plus bounded campaign fields; never collect arbitrary query data.
  const page = new URL(location.href);
  const campaign = new URLSearchParams();
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_id",
    "utm_content",
    "utm_term",
  ]) {
    const value = page.searchParams.get(key);
    if (value && !value.includes("@")) campaign.set(key, value.slice(0, 100));
  }
  page.search = campaign.toString();
  page.hash = "";
  const analytics = script("https://analytics.ahrefs.com/analytics.js");
  analytics.dataset.key = ahrefsKey;
  analytics.dataset.pageLocation = page.href;
  document.head.append(analytics);

  // One delegated listener also covers hydrated links on the approved live page.
  // These are navigation intentions, never completed applications.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const link =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) return;
    const target = new URL(link.href);
    const name =
      target.origin === location.origin && target.pathname === "/download/"
        ? "get_started_open"
        : link.dataset.analyticsEvent === "beta_form_open"
          ? "beta_form_open"
          : null;
    if (name) {
      try {
        window.AhrefsAnalytics?.sendEvent(name);
      } catch {
        console.warn("website_analytics_unavailable");
      }
    }
  });
})();
