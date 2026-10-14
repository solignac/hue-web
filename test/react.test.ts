import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type Subscribable, useHue } from '../src/react.js';

const source: Subscribable<{ count: number; label: string }> = {
  subscribe: () => () => {},
  getSnapshot: () => ({ count: 3, label: 'lights' }),
};

describe('useHue', () => {
  it('reads a snapshot, whole or through a selector', () => {
    function Whole() {
      const s = useHue(source);
      return createElement('p', null, `${s.count} ${s.label}`);
    }
    function Selected() {
      return createElement(
        'p',
        null,
        useHue(source, (s) => s.count),
      );
    }
    expect(renderToString(createElement(Whole))).toBe('<p>3 lights</p>');
    expect(renderToString(createElement(Selected))).toBe('<p>3</p>');
  });
});
