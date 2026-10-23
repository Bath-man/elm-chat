import type { KeyboardEvent, MouseEvent } from "react";

export function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  // Enter confirms IME candidates; some browsers report keyCode 229 while
  // finishing composition even when isComposing has already become false.
  if (
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }

  const form = event.currentTarget.form;
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}

export function preserveComposerFocus(event: MouseEvent<HTMLButtonElement>) {
  if (event.button !== 0 || event.currentTarget.disabled) return;
  const textarea = event.currentTarget.form?.querySelector("textarea");
  // Keep the existing keyboard session alive before pointer activation can blur
  // it. Never refocus after async sending: the user may have dismissed it.
  if (textarea && event.currentTarget.ownerDocument.activeElement === textarea) {
    event.preventDefault();
  }
}
