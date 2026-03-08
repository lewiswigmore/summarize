export function normalizePanelUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function panelUrlsMatch(a: string, b: string) {
  const left = normalizePanelUrl(a);
  const right = normalizePanelUrl(b);
  if (left === right) return true;
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false;
    if (longer.length === shorter.length) return true;
    const next = longer[shorter.length];
    return next === "/" || next === "?" || next === "&";
  };
  return boundaryMatch(left, right) || boundaryMatch(right, left);
}

function isMatchablePanelUrl(value: string | null) {
  if (!value) return false;
  return !(
    value.startsWith("chrome://") ||
    value.startsWith("chrome-extension://") ||
    value.startsWith("moz-extension://") ||
    value.startsWith("edge://") ||
    value.startsWith("about:")
  );
}

export type PanelNavigationDecision = {
  kind: "none" | "tab" | "url";
  preserveChat: boolean;
  shouldAbortChatStream: boolean;
  shouldClearChat: boolean;
  shouldMigrateChat: boolean;
  shouldAppendNavigationMessage: boolean;
  nextInputMode: "page" | "video" | null;
  resetInputModeOverride: boolean;
};

export function resolvePanelNavigationDecision({
  activeTabId,
  activeTabUrl,
  nextTabId,
  nextTabUrl,
  hasActiveChat,
  chatEnabled,
  preserveChat,
  preferUrlMode,
  inputModeOverride,
}: {
  activeTabId: number | null;
  activeTabUrl: string | null;
  nextTabId: number | null;
  nextTabUrl: string | null;
  hasActiveChat: boolean;
  chatEnabled: boolean;
  preserveChat: boolean;
  preferUrlMode: boolean;
  inputModeOverride: "page" | "video" | null;
}): PanelNavigationDecision {
  const tabChanged = nextTabId !== activeTabId;
  const urlChanged =
    !tabChanged && nextTabUrl && (!activeTabUrl || !panelUrlsMatch(nextTabUrl, activeTabUrl));

  if (!tabChanged && !urlChanged) {
    return {
      kind: "none",
      preserveChat,
      shouldAbortChatStream: false,
      shouldClearChat: false,
      shouldMigrateChat: false,
      shouldAppendNavigationMessage: false,
      nextInputMode: null,
      resetInputModeOverride: false,
    };
  }

  if (tabChanged) {
    return {
      kind: "tab",
      preserveChat,
      shouldAbortChatStream: !preserveChat,
      shouldClearChat: !preserveChat,
      shouldMigrateChat: preserveChat,
      shouldAppendNavigationMessage: false,
      nextInputMode: preferUrlMode ? "video" : "page",
      resetInputModeOverride: true,
    };
  }

  return {
    kind: "url",
    preserveChat,
    shouldAbortChatStream: false,
    shouldClearChat: !preserveChat && chatEnabled && hasActiveChat,
    shouldMigrateChat: false,
    shouldAppendNavigationMessage: chatEnabled && hasActiveChat && Boolean(nextTabUrl),
    nextInputMode: inputModeOverride ? null : preferUrlMode ? "video" : "page",
    resetInputModeOverride: false,
  };
}

export function shouldAcceptRunForCurrentPage({
  runUrl,
  activeTabUrl,
  currentSourceUrl,
}: {
  runUrl: string;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  const expectedUrl = currentSourceUrl ?? (isMatchablePanelUrl(activeTabUrl) ? activeTabUrl : null);
  if (!expectedUrl) return true;
  return panelUrlsMatch(runUrl, expectedUrl);
}

export function shouldAcceptSlidesForCurrentPage({
  targetUrl,
  activeTabUrl,
  currentSourceUrl,
}: {
  targetUrl: string | null;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  if (!targetUrl) return true;
  const expectedUrl = currentSourceUrl ?? (isMatchablePanelUrl(activeTabUrl) ? activeTabUrl : null);
  if (!expectedUrl) return true;
  return panelUrlsMatch(targetUrl, expectedUrl);
}

export function shouldInvalidateCurrentSource({
  stateTabUrl,
  currentSourceUrl,
}: {
  stateTabUrl: string | null;
  currentSourceUrl: string | null;
}) {
  if (!stateTabUrl || !currentSourceUrl) return false;
  return !panelUrlsMatch(stateTabUrl, currentSourceUrl);
}
