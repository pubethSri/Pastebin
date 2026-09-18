/**
 * Copying is the entire point of this app, and the obvious API does not work
 * where the app runs.
 *
 * `navigator.clipboard` is gated on a *secure context*. `http://localhost`
 * qualifies; **`http://192.168.1.x` does not.** So on every device that isn't
 * the host PC — which is every device this app exists for — `navigator.clipboard`
 * is `undefined` and a naive copy button silently does nothing. The bug is
 * invisible during development, because development happens on localhost.
 *
 * So: check `isSecureContext` synchronously and branch. The fallback is a
 * hidden textarea plus `document.execCommand("copy")` — deprecated, but
 * implemented everywhere and unbothered by plain HTTP.
 *
 * The synchronous branch matters. `execCommand` only works inside the user
 * gesture that triggered it; awaiting a rejected clipboard promise first would
 * often push it outside that window. The rejection path below is a last resort,
 * not the plan.
 */
export function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => legacyCopy(text),
    );
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but focusable. `position: fixed` avoids the page scrolling to it,
  // and a zero-ish size keeps iOS from flashing a caret.
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;";
  document.body.appendChild(ta);

  // Preserve whatever the user had selected; clobbering it to copy is rude.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  let ok = false;
  try {
    if (isIos()) {
      // iOS Safari ignores .select() on a readonly textarea. The documented
      // workaround is to make it editable and select its contents as a range.
      ta.contentEditable = "true";
      ta.readOnly = false;
      const range = document.createRange();
      range.selectNodeContents(ta);
      selection?.removeAllRanges();
      selection?.addRange(range);
      ta.setSelectionRange(0, text.length);
    } else {
      ta.select();
      ta.setSelectionRange(0, text.length);
    }
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }

  document.body.removeChild(ta);
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

const isIos = (): boolean =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  // iPadOS 13+ reports as a Mac; the touch points give it away.
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
