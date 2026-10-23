import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleComposerKeyDown, preserveComposerFocus } from "../apps/web/src/composer";

function keyEvent(overrides: Record<string, unknown> = {}) {
  const submit = vi.fn();
  const preventDefault = vi.fn();
  const event = {
    key: "Enter",
    nativeEvent: { isComposing: false, keyCode: 13 },
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    currentTarget: { form: { requestSubmit: submit } },
    preventDefault,
    ...overrides
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, submit, preventDefault };
}

describe("composer keyboard submission", () => {
  it("submits plain Enter through the form and suppresses the newline", () => {
    const { event, submit, preventDefault } = keyEvent();
    handleComposerKeyDown(event);
    expect(submit).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ["active IME composition", { nativeEvent: { isComposing: true, keyCode: 13 } }],
    ["composition confirmation reported as key code 229", { nativeEvent: { isComposing: false, keyCode: 229 } }],
    ["Shift+Enter newline", { shiftKey: true }],
    ["Ctrl+Enter", { ctrlKey: true }],
    ["Meta+Enter", { metaKey: true }],
    ["Alt+Enter", { altKey: true }],
    ["ordinary typing", { key: "a" }],
    ["missing form", { currentTarget: { form: null } }]
  ])("leaves %s to the browser without sending", (_name, overrides) => {
    const { event, submit, preventDefault } = keyEvent(overrides);
    handleComposerKeyDown(event);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

// Pointer focus changes happen before click/submit; preserve an existing typing
// session without ever focusing a composer the user has left.
describe("send button focus", () => {
  function press({ active = true, button = 0, disabled = false } = {}) {
    const textarea = {};
    const preventDefault = vi.fn();
    const event = {
      button,
      currentTarget: {
        disabled,
        form: { querySelector: () => textarea },
        ownerDocument: { activeElement: active ? textarea : {} }
      },
      preventDefault
    } as unknown as import("react").MouseEvent<HTMLButtonElement>;
    return { event, preventDefault };
  }

  it("prevents the send button from stealing the active textarea focus", () => {
    const { event, preventDefault } = press();
    preserveComposerFocus(event);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ["a dismissed/unfocused composer", { active: false }],
    ["a non-primary click", { button: 2 }],
    ["a disabled send button", { disabled: true }]
  ])("does not interfere with %s", (_name, options) => {
    const { event, preventDefault } = press(options);
    preserveComposerFocus(event);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
