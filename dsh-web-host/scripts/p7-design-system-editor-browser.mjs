export function installCompanyDesignSystemBrowser(gateway, projectId) {
  const fetchNative = window.fetch.bind(window);
  const page = new URL(window.location.href);
  const browserBase = new URL("./", page).pathname;
  const pathAllowed = /^(?:_files\.json|__deck\/(?:session|events|publish|assets)|__presence|project\/.+|_blob\/[a-f0-9]{32})$/;

  function translate(value) {
    const url = new URL(String(value), page);
    if (url.origin !== page.origin) return null;
    const path = url.pathname.startsWith(browserBase)
      ? url.pathname.slice(browserBase.length)
      : url.pathname.startsWith("/_blob/") ? url.pathname.slice(1) : "";
    const decoded = decodeURIComponent(path);
    if (!pathAllowed.test(decoded)) return null;
    const target = new URL(gateway, page);
    target.searchParams.set("id", projectId);
    target.searchParams.set("path", decoded);
    if (decoded === "__deck/events" || decoded === "__presence") {
      for (const [name, value] of url.searchParams) target.searchParams.append(name, value);
    }
    return target.href;
  }

  window.fetch = function (value, init) {
    const target = translate(value instanceof Request ? value.url : value);
    const input = target && value instanceof Request ? new Request(target, value) : target || value;
    return fetchNative(input, init);
  };

  const EventSourceNative = window.EventSource;
  if (EventSourceNative) {
    window.EventSource = class extends EventSourceNative {
      constructor(value, init) {
        super(translate(value) || value, init);
      }
    };
  }

}
