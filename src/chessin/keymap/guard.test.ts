import { expect, test } from "vitest";
import { guardTyping, isEditableElement, isTypingTarget } from "./guard";

function keydown(target: EventTarget | null, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: "f", bubbles: true, ...init });
    if (target) Object.defineProperty(e, "target", { value: target });
    return e;
}

test("text inputs, textareas, selects and contenteditable are typing targets", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(isTypingTarget(keydown(input))).toBe(true);
    expect(isTypingTarget(keydown(textarea))).toBe(true);
    expect(isTypingTarget(keydown(select))).toBe(true);
    expect(isTypingTarget(keydown(editable))).toBe(true);
});

test("non-text inputs and plain elements are not typing targets", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const button = document.createElement("button");
    const div = document.createElement("div");

    expect(isTypingTarget(keydown(checkbox))).toBe(false);
    expect(isTypingTarget(keydown(button))).toBe(false);
    expect(isTypingTarget(keydown(div))).toBe(false);
    expect(isTypingTarget(keydown(document.body))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
});

test("IME composition is a typing context regardless of target", () => {
    const div = document.createElement("div");
    expect(isTypingTarget(keydown(div, { isComposing: true }))).toBe(true);
    expect(isTypingTarget({ target: div, keyCode: 229 })).toBe(true);
});

test("descendants of a contenteditable editor are editable", () => {
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    const span = document.createElement("span");
    editor.appendChild(span);
    document.body.appendChild(editor);

    expect(isEditableElement(span)).toBe(true);
    document.body.removeChild(editor);
});

test("guardTyping skips the handler in typing contexts only", () => {
    let calls = 0;
    const handler = guardTyping(() => {
        calls += 1;
    });
    handler(keydown(document.createElement("input")));
    expect(calls).toBe(0);
    handler(keydown(document.createElement("div")));
    expect(calls).toBe(1);
});
