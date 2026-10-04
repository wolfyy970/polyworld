/**
 * Lane W1g — DOM helpers.
 *
 * PORT-NOTE (W1g/ui): the shell uses no UI framework (task constraint). These three
 * functions are the whole "framework": create an element, set text, set attributes. Keeping
 * DOM construction in TypeScript means the control bar and the status panel are typed and
 * testable-by-inspection, and index.html stays the pre-boot shell (markup only).
 */

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      // Booleans map to presence/absence, not to the string "false".
      if (typeof value === 'boolean') {
        if (value) node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) node.append(child);
  return node;
}

/** Update a node's text only when it changed — avoids needless layout work at 5 Hz. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setPressed(node: HTMLElement, pressed: boolean): void {
  node.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}
