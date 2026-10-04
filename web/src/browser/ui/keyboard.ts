/**
 * Lane W1g — keyboard shortcuts.
 *
 * Shortcuts are a second path to the same handlers the buttons call, so there is exactly one
 * implementation of each action. Events are ignored while a form control has focus, which
 * matters for Space: otherwise pressing it on a focused button would fire the button's own
 * click *and* the global toggle.
 */

export interface KeyboardHandlers {
  toggleRun(): void;
  stepOnce(): void;
  resetRun(): void;
  resetView(): void;
  /** 1-based shortcut index into `speeds`. Out-of-range indexes are ignored. */
  setSpeedByIndex(index: number): void;
}

const FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [contenteditable="true"]';

export function bindKeyboard(handlers: KeyboardHandlers, speeds: readonly number[]): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest(FOCUSABLE_SELECTOR)) return;

    switch (event.key) {
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        handlers.toggleRun();
        return;
      case '.':
      case 's':
        event.preventDefault();
        handlers.stepOnce();
        return;
      case 'r':
      case 'R':
        event.preventDefault();
        handlers.resetRun();
        return;
      case 'v':
      case 'V':
        event.preventDefault();
        handlers.resetView();
        return;
      default:
        break;
    }

    // Digit keys 1..n select a speed, matching the order of the speed buttons.
    const digit = Number.parseInt(event.key, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= speeds.length) {
      event.preventDefault();
      handlers.setSpeedByIndex(digit - 1);
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
