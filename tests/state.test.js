import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState, canTransition, createMachine } from '../public/js/state.js';

test('full happy-path gameplay loop', () => {
  const path = [
    ['home', 'start', 'setup'],
    ['setup', 'scout', 'scouting'],
    ['scouting', 'ready', 'countdown'],
    ['countdown', 'go', 'briefing'],
    ['briefing', 'begin', 'rally'],
    ['rally', 'arrive', 'discovered'],
    ['discovered', 'again', 'setup'],
  ];
  for (const [from, ev, to] of path) assert.equal(nextState(from, ev), to);
});

test('cannot skip from briefing straight to discovered, or complete from home', () => {
  assert.throws(() => nextState('briefing', 'arrive'), /Illegal/);
  assert.throws(() => nextState('home', 'arrive'), /Illegal/);
  assert.throws(() => nextState('scouting', 'begin'), /Illegal/);
  assert.equal(canTransition('rally', 'arrive'), true);
  assert.equal(canTransition('setup', 'arrive'), false);
});

test('failure and abandon edges', () => {
  assert.equal(nextState('scouting', 'fail'), 'setup');
  assert.equal(nextState('scouting', 'cancel'), 'setup');
  assert.equal(nextState('rally', 'abandon'), 'home');
  assert.equal(nextState('briefing', 'abandon'), 'home');
});

test('refresh recovery edges', () => {
  assert.equal(nextState('home', 'resume'), 'rally');
  assert.equal(nextState('home', 'resumeBriefing'), 'briefing');
});

test('machine notifies subscribers with from/to/event/payload', () => {
  const m = createMachine();
  const seen = [];
  const off = m.subscribe((to, from, ev, p) => seen.push([from, to, ev, p]));
  m.send('start');
  m.send('scout', { x: 1 });
  off();
  m.send('cancel');
  assert.deepEqual(seen, [['home', 'setup', 'start', undefined], ['setup', 'scouting', 'scout', { x: 1 }]]);
  assert.equal(m.state, 'setup');
  assert.throws(() => m.send('arrive'));
  assert.equal(m.state, 'setup', 'state unchanged after illegal event');
});
