import { describe, expect, it } from 'vitest';
import { DEFAULT_SHELL_CONFIG, SHELL_SPEEDS, parseShellConfig } from './config';

describe('parseShellConfig', () => {
  it('falls back to defaults for an empty query', () => {
    expect(parseShellConfig('')).toEqual(DEFAULT_SHELL_CONFIG);
    expect(parseShellConfig('?')).toEqual(DEFAULT_SHELL_CONFIG);
  });

  it('reads known keys, with or without the leading question mark', () => {
    const expected = { scenario: DEFAULT_SHELL_CONFIG.scenario, seed: 42, agents: 200, stepHz: 60, speed: 4 };
    expect(parseShellConfig('?seed=42&agents=200&stepHz=60&speed=4')).toEqual(expected);
    expect(parseShellConfig('seed=42&agents=200&stepHz=60&speed=4')).toEqual(expected);
  });

  it('clamps out-of-range integers instead of trusting the URL', () => {
    expect(parseShellConfig('?agents=0').agents).toBe(1);
    expect(parseShellConfig('?agents=99999').agents).toBe(4096);
    expect(parseShellConfig('?stepHz=-5').stepHz).toBe(1);
    expect(parseShellConfig('?stepHz=100000').stepHz).toBe(240);
    expect(parseShellConfig('?seed=-1').seed).toBe(0);
  });

  it('ignores junk values', () => {
    expect(parseShellConfig('?agents=abc&seed=&stepHz=NaN').agents).toBe(DEFAULT_SHELL_CONFIG.agents);
    expect(parseShellConfig('?agents=abc&seed=&stepHz=NaN').seed).toBe(DEFAULT_SHELL_CONFIG.seed);
    expect(parseShellConfig('?agents=abc&seed=&stepHz=NaN').stepHz).toBe(DEFAULT_SHELL_CONFIG.stepHz);
  });

  it('boots the default scenario unless a known one is asked for', () => {
    expect(parseShellConfig('').scenario).toBe(DEFAULT_SHELL_CONFIG.scenario);
    expect(parseShellConfig('?scenario=minitest_von').scenario).toBe('minitest_von');
    expect(parseShellConfig('?scenario=microtest_voff').scenario).toBe('microtest_voff');
    // Unknown names fall back rather than throwing: a URL must not be able to break the shell.
    expect(parseShellConfig('?scenario=nope').scenario).toBe(DEFAULT_SHELL_CONFIG.scenario);
    expect(parseShellConfig('?scenario=').scenario).toBe(DEFAULT_SHELL_CONFIG.scenario);
  });

  it('leaves the seed to the worldfile when the URL does not say', () => {
    // `null` means "use the worldfile's PositionSeed" (see app.ts / simSeam.ts).
    expect(parseShellConfig('').seed).toBeNull();
    expect(parseShellConfig('?seed=').seed).toBeNull();
    expect(parseShellConfig('?seed=7').seed).toBe(7);
  });

  it('snaps speed to one of the offered multipliers', () => {
    expect(parseShellConfig('?speed=3.9').speed).toBe(4);
    expect(parseShellConfig('?speed=0.4').speed).toBe(0.5);
    expect(parseShellConfig('?speed=1000').speed).toBe(8);
    expect(parseShellConfig('?speed=-2').speed).toBe(DEFAULT_SHELL_CONFIG.speed);
    expect(SHELL_SPEEDS).toContain(parseShellConfig('?speed=2').speed);
  });
});
