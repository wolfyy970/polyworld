/**
 * Lane W1g — control bar: play/pause, single step, speed, restart.
 *
 * PORT-NOTE (W1g/ui): the native app drives the simulation from Qt widgets/menus
 * (`app/ui`, lane L18-native). The browser shell keeps the smallest set that makes the demo
 * usable: run state, one-step, sim speed, and a new run of the same world. Everything else
 * (worldfile selection, parameter editors) is deliberately absent.
 *
 * Accessibility: real <button> elements with aria-pressed for toggles, so the bar works
 * from the keyboard and reads correctly to a screen reader.
 */

import { el, setPressed } from './dom';

export interface ControlBarState {
  running: boolean;
  speed: number;
}

export interface ControlHandlers {
  toggleRun(): void;
  stepOnce(): void;
  setSpeed(speed: number): void;
  resetRun(): void;
  resetView(): void;
}

export interface ControlBarOptions {
  speeds: readonly number[];
  initialSpeed: number;
}

export interface ControlBar {
  element: HTMLElement;
  update(state: ControlBarState): void;
}

export function createControlBar(handlers: ControlHandlers, options: ControlBarOptions): ControlBar {
  const runButton = el('button', {
    className: 'btn btn--primary btn--wide',
    text: 'Play',
    attrs: { type: 'button', 'aria-pressed': 'false', title: 'Play / pause (space)' },
  });
  runButton.addEventListener('click', () => handlers.toggleRun());

  const stepButton = el('button', {
    className: 'btn',
    text: 'Step',
    attrs: { type: 'button', title: 'Advance one step (.)' },
  });
  stepButton.addEventListener('click', () => handlers.stepOnce());

  const resetButton = el('button', {
    className: 'btn',
    text: 'New run',
    attrs: { type: 'button', title: 'Start a new run under the next InitSeed (r)' },
  });
  resetButton.addEventListener('click', () => handlers.resetRun());

  const viewButton = el('button', {
    className: 'btn',
    text: 'View',
    attrs: { type: 'button', title: 'Reset the camera (v)' },
  });
  viewButton.addEventListener('click', () => handlers.resetView());

  const speedButtons: HTMLButtonElement[] = [];
  const speedGroup = el(
    'div',
    { className: 'speed', attrs: { role: 'group', 'aria-label': 'Simulation speed' } },
    [el('span', { className: 'speed__label', text: 'speed' })],
  );
  options.speeds.forEach((speed, index) => {
    const label = formatSpeed(speed);
    const button = el('button', {
      className: 'btn',
      text: label,
      attrs: {
        type: 'button',
        'aria-pressed': speed === options.initialSpeed ? 'true' : 'false',
        title: `${label} simulated time (${index + 1})`,
      },
    });
    button.dataset.speed = String(speed);
    button.addEventListener('click', () => handlers.setSpeed(speed));
    speedButtons.push(button);
    speedGroup.append(button);
  });

  const hint = el('p', { className: 'panel__note controls__hint' }, [
    el('span', { className: 'kbd', text: 'space' }),
    ' play/pause · ',
    el('span', { className: 'kbd', text: '.' }),
    ' step · ',
    el('span', { className: 'kbd', text: 'r' }),
    ' new run · ',
    el('span', { className: 'kbd', text: 'v' }),
    ' view · ',
    el('span', { className: 'kbd', text: '1' }),
    '–',
    el('span', { className: 'kbd', text: String(options.speeds.length) }),
    ' speed · drag to orbit, wheel to zoom',
  ]);

  const element = el('div', { className: 'panel controls' }, [
    runButton,
    stepButton,
    el('span', { className: 'status__sep' }),
    speedGroup,
    el('span', { className: 'status__sep' }),
    resetButton,
    viewButton,
    hint,
  ]);

  return {
    element,
    update(state: ControlBarState): void {
      runButton.textContent = state.running ? 'Pause' : 'Play';
      setPressed(runButton, state.running);
      for (const button of speedButtons) {
        const speed = Number(button.dataset.speed);
        setPressed(button, speed === state.speed);
      }
    },
  };
}

function formatSpeed(speed: number): string {
  return `${Number.isInteger(speed) ? speed : speed.toString().replace(/^0\./, '.')}×`;
}
