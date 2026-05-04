"use strict";

(() => {
  if (window.__eastmoneyQtClistHooked) return;
  window.__eastmoneyQtClistHooked = true;
  const TARGET_PATH = "/api/qt/clist/get";

  function isQtClistUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!url.pathname.includes(TARGET_PATH)) return false;
      return ["fs", "fields", "pn", "pz"].every((key) => url.searchParams.has(key));
    } catch {
      return false;
    }
  }

  function forward(url, body) {
    document.dispatchEvent(
      new CustomEvent("__eastmoneyQtclistCaptured", { detail: { url, body } })
    );
  }

  const origFetch = window.fetch;
  window.fetch = function eastmoneyFetchHook(...args) {
    const req = args[0];
    const urlStr =
      typeof req === "string"
        ? req
        : req && typeof req.url === "string"
          ? req.url
          : "";
    const abs = urlStr ? new URL(urlStr, location.href).href : "";

    return origFetch.apply(this, args).then((res) => {
      if (abs && isQtClistUrl(abs)) {
        res
          .clone()
          .text()
          .then((body) => forward(abs, body))
          .catch(() => {});
      }
      return res;
    });
  };

  const XO = XMLHttpRequest.prototype;
  const origOpen = XO.open;
  const origSend = XO.send;
  XO.open = function eastmoneyXHROpen(method, url, ...rest) {
    this.__qtClistUrl = typeof url === "string" ? url : "";
    return origOpen.call(this, method, url, ...rest);
  };
  XO.send = function eastmoneyXHRSend(...args) {
    this.addEventListener("load", function onQtClistLoad() {
      const u = this.__qtClistUrl;
      if (!u || !this.responseText) return;
      const abs = new URL(u, location.href).href;
      if (isQtClistUrl(abs)) forward(abs, this.responseText);
    });
    return origSend.apply(this, args);
  };
})();
