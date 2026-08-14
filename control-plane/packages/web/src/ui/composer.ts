/**
 * Prompt entry, interrupt, and the slash palette.
 *
 * Enter sends. Everywhere, including on a phone: an operator who has typed an
 * instruction and pressed the send key means it, and a composer that quietly
 * inserts a newline instead reads as a broken app. Shift+Enter is the newline.
 *
 * While a turn is in flight the field locks and Cancel takes the send key's
 * place, because the useful action during a turn is stopping it.
 */

import type { SlashCommand } from "../session/model.ts";
import { el, setText, toggleClass } from "./dom.ts";
import { icon } from "./icons.ts";

export interface ComposerOptions {
  onSubmit(text: string): void;
  onCancel(): void;
}

export interface ComposerView {
  readonly element: HTMLElement;
  /** A turn is streaming: lock the field and offer the interrupt. */
  setBusy(busy: boolean): void;
  /** No agent selected, or the link is down. */
  setEnabled(enabled: boolean): void;
  setCommands(commands: readonly string[], details: ReadonlyMap<string, SlashCommand>): void;
  focusInput(): void;
  clear(): void;
}

/** Commands offered at once. More than this is a list nobody reads. */
const MENU_LIMIT = 8;

export function createComposer(options: ComposerOptions): ComposerView {
  const input = el("textarea", {
    class: "composer-input",
    attrs: {
      rows: "1",
      placeholder: "Instruct the agent. / for commands.",
      "aria-label": "Prompt",
      autocapitalize: "sentences",
      autocomplete: "off",
      spellcheck: "false",
    },
  });

  const send = el("button", {
    class: "btn btn-send",
    attrs: { type: "submit", "aria-label": "Send prompt" },
    children: [icon("send")],
  });

  const cancel = el("button", {
    class: "btn btn-interrupt",
    attrs: { type: "button", "aria-label": "Interrupt this turn" },
    children: [icon("interrupt"), el("span", { class: "btn-text", text: "Interrupt" })],
  });
  cancel.hidden = true;

  const hint = el("p", { class: "composer-hint", text: "enter sends · shift+enter newline" });

  const menu = el("ul", {
    class: "palette",
    attrs: { role: "listbox", "aria-label": "Slash commands" },
  });
  menu.hidden = true;

  const form = el("form", {
    class: "composer",
    attrs: { autocomplete: "off" },
    children: [menu, el("div", { class: "composer-row", children: [input, cancel, send] }), hint],
  });

  let enabled = true;
  let busy = false;
  let commands: readonly string[] = [];
  let details: ReadonlyMap<string, SlashCommand> = new Map();
  let matches: string[] = [];
  let active = 0;

  // -- palette --------------------------------------------------------------

  /** The command fragment being typed, or null when this is not a command. */
  function fragment(): string | null {
    if (input.selectionStart !== input.value.length) return null;
    const match = /^\/([\w:-]*)$/.exec(input.value);
    return match === null ? null : (match[1] ?? "");
  }

  function closeMenu(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    matches = [];
    input.removeAttribute("aria-activedescendant");
  }

  function paintActive(): void {
    for (let index = 0; index < menu.children.length; index += 1) {
      const option = menu.children[index];
      if (!(option instanceof HTMLElement)) continue;
      const on = index === active;
      toggleClass(option, "is-active", on);
      option.setAttribute("aria-selected", on ? "true" : "false");
      if (on) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function accept(name: string): void {
    input.value = `/${name} `;
    closeMenu();
    input.focus();
    grow();
  }

  function openMenu(): void {
    const typed = fragment();
    if (typed === null || commands.length === 0) {
      closeMenu();
      return;
    }
    const needle = typed.toLowerCase();
    matches = commands.filter((name) => name.toLowerCase().startsWith(needle)).slice(0, MENU_LIMIT);
    if (matches.length === 0) {
      closeMenu();
      return;
    }

    active = 0;
    const options: HTMLElement[] = [];
    for (const [index, name] of matches.entries()) {
      const detail = details.get(name);
      const option = el("li", {
        class: "palette-option",
        attrs: { role: "option", id: `palette-${index}`, "aria-selected": "false" },
        children: [
          el("code", { class: "palette-name", text: `/${name}` }),
          el("span", { class: "palette-desc", text: detail?.description ?? "" }),
          detail?.hint ? el("code", { class: "palette-hint", text: detail.hint }) : null,
        ],
      });
      option.addEventListener("mousedown", (event: MouseEvent) => {
        // mousedown, not click: the textarea must not lose focus first.
        event.preventDefault();
        accept(name);
      });
      options.push(option);
    }
    menu.replaceChildren(...options);
    menu.hidden = false;
    paintActive();
  }

  // -- field ----------------------------------------------------------------

  function grow(): void {
    // Reset first: without it the field can only ever get taller.
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  function submit(): void {
    if (!enabled || busy) return;
    const text = input.value.trim();
    if (text.length === 0) return;
    input.value = "";
    closeMenu();
    grow();
    options.onSubmit(text);
  }

  form.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    submit();
  });

  cancel.addEventListener("click", () => {
    options.onCancel();
  });

  input.addEventListener("input", () => {
    grow();
    openMenu();
  });

  input.addEventListener("blur", closeMenu);

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!menu.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        paintActive();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        const name = matches[active];
        if (name !== undefined) {
          event.preventDefault();
          accept(name);
          return;
        }
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    // A composing IME uses Enter to commit a candidate, not to send.
    if (event.isComposing) return;
    event.preventDefault();
    submit();
  });

  // -- state ----------------------------------------------------------------

  function paint(): void {
    input.disabled = !enabled || busy;
    send.disabled = !enabled || busy;
    send.hidden = busy;
    cancel.hidden = !busy;
    toggleClass(form, "is-busy", busy);
    toggleClass(form, "is-idle", !busy);
    setText(hint, busy ? "turn in flight · interrupt to take it back" : "enter sends · shift+enter newline");
    if (busy) closeMenu();
  }

  return {
    element: form,
    setBusy(next: boolean): void {
      if (busy === next) return;
      busy = next;
      paint();
    },
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      paint();
    },
    setCommands(nextCommands: readonly string[], nextDetails: ReadonlyMap<string, SlashCommand>): void {
      commands = nextCommands;
      details = nextDetails;
    },
    focusInput(): void {
      input.focus();
    },
    clear(): void {
      input.value = "";
      closeMenu();
      grow();
    },
  };
}
