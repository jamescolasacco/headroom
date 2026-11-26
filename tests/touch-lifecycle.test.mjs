// Touch gestures interrupted: the window loses focus or the page hides (app switch) with a finger down, the system
// cancels the touch, control is turned off or the connection drops mid-drag, the mode changes, the phone turns,
// and the session is left and joined again. Checked by what the Mac host ends up holding (tests/touch-fixture.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { TouchInput } from '../web/js/input/touch.js';
import { touchFixture } from './touch-fixture.mjs';

const X = 195, Y = 300;

/** Each way the session interrupts a gesture: what TouchInput is told (session.js _releaseInput / blur / cancel). */
const interruptions = {
  blur: f => f.touch.releaseAll(),                 // window blur, page hidden (session.js)
  cancel: f => f.cancel(1),                        // the system took the touch (app switcher, edge swipe)
  revoked: f => { f.state.allowed = false; f.hostReleases(); f.touch.releaseAll(); }, // view only: the host lets go itself
  dropped: f => { f.state.allowed = false; f.hostReleases(); f.touch.releaseAll(); }, // socket closed: the host lets go
  mode: f => f.touch.setMode(f.touch.mode === 'touch' ? 'trackpad' : 'touch'),
};

test('a drag interrupted any way ends with nothing held; the finger\'s later moves and lift do nothing; the next tap is a plain click', t => {
  for (const mode of ['touch', 'trackpad']) {
    for (const [name, interrupt] of Object.entries(interruptions)) {
      const f = touchFixture(t, { mode });
      f.tap(X, Y);
      f.advance(120);
      f.slide(X, Y, 60, 0, { keep: true }); // tap, then touch and drag
      assert.equal(f.touch.buttonDown, true);
      interrupt(f);
      assert.deepEqual(f.host().held, [], `${mode}/${name}: released at once`);
      const sentBefore = f.sent.length;
      f.advance(16); f.move(1, X + 120, Y + 20); f.advance(16); f.up(1);
      f.advance(1000);
      assert.equal(f.sent.length, sentBefore, `${mode}/${name}: nothing after the interruption`);
      f.state.allowed = true; // control back, or reconnected
      f.tap(X, Y);
      f.advance(1000);
      const h = f.host();
      assert.deepEqual(h.presses.at(-1), [0, 1], `${mode}/${name}: the next tap is one click`);
      assert.deepEqual(h.held, []);
      assert.equal(f.touch.touches.size, 0);
      assert.equal(f.touch.g, null);
    }
  }
});

test('a double click whose release is held for a drag lets go at once when interrupted', t => {
  for (const [name, interrupt] of Object.entries(interruptions)) {
    if (name === 'cancel') continue; // no finger down
    const f = touchFixture(t);
    f.tap(X, Y); f.advance(110); f.tap(X, Y);
    f.advance(100);
    assert.ok(f.touch.held, 'the double click is still down');
    interrupt(f);
    assert.deepEqual(f.host().held, [], name);
    assert.equal(f.touch.held, null);
    f.advance(1000);
    f.state.allowed = true;
    f.tap(X, Y);
    f.advance(1000);
    assert.deepEqual(f.host().presses.slice(-1), [[0, 1]], name);
  }
});

test('a right-click drag interrupted releases the right button', t => {
  for (const [name, interrupt] of Object.entries(interruptions)) {
    const f = touchFixture(t);
    f.two(X, Y); f.advance(150);
    f.two(X, Y, 50, 30, { keep: true });
    f.frame();
    assert.equal(f.touch.rightDown, true, name);
    interrupt(f);
    assert.deepEqual(f.host().held, [], name);
    assert.equal(f.touch.rightDown, false);
    f.up(2); f.up(1);
    f.advance(1000);
    assert.equal(f.host().presses.filter(([b]) => b === 2).length, 2, `${name}: no right-click from the lift`);
  }
});

test('momentum stops when the window loses focus, the page hides or control ends, and doesn\'t come back', t => {
  for (const name of ['blur', 'revoked', 'mode']) {
    const f = touchFixture(t);
    f.two(X, Y, 0, -150);
    f.advance(50);
    assert.ok(f.touch.inertia);
    interruptions[name](f);
    const at = f.clock.now;
    f.state.allowed = true;
    f.advance(2000);
    assert.ok(!f.host().events.some(e => e.type === 'wheel' && e.t > at), name);
    assert.equal(f.touch.inertia, 0);
  }
});

test('a pinch interrupted cancels the remote zoom contacts', t => {
  const f = touchFixture(t);
  f.down(1, 150, 300); f.down(2, 250, 300);
  for (let i = 1; i <= 4; i++) { f.advance(16); f.move(1, 150 - 5 * i, 300); f.move(2, 250 + 5 * i, 300); }
  f.advance(16);
  assert.equal(f.touch.g.kind, 'pinch');
  f.touch.releaseAll();
  assert.deepEqual(f.local.endPinch, [true]);
  f.up(1); f.up(2);
  assert.deepEqual(f.local.endPinch, [true], 'the lifts after it do nothing more');
});

test('leaving and joining again: the new session\'s touch handles each event once, the old one none', t => {
  const f = touchFixture(t);
  f.touch.detach();
  let second;
  for (let i = 0; i < 5; i++) {
    second?.detach();
    second = new TouchInput(f.ctx);
    second.setMode('trackpad');
    second.attach();
  }
  t.after(() => second.detach());
  f.tap(X, Y);
  f.advance(1000);
  assert.deepEqual(f.host().presses, [[0, 1]]);
  f.tap(X, Y); f.advance(110); f.tap(X, Y);
  f.advance(1000);
  assert.deepEqual(f.host().presses, [[0, 1], [0, 1], [0, 2]]);
  assert.deepEqual(f.host().held, []);
});

test('the phone turning between gestures: touch mode taps land under the finger in the new layout', t => {
  const f = touchFixture(t, { mode: 'touch' });
  f.tap(100, 250);
  f.advance(1000);
  // Landscape: the desktop is drawn bigger, at another place.
  Object.assign(f.viewport, { scale: 0.55, ox: 70, oy: 0 });
  f.tap(400, 150);
  f.advance(1000);
  const presses = f.host().events.filter(e => e.type === 'down');
  assert.deepEqual([presses[1].x, presses[1].y].map(Math.round), [Math.round((400 - 70) / (1280 * 0.55) * 1280), Math.round(150 / (720 * 0.55) * 720)]);
  assert.deepEqual(f.host().presses, [[0, 1], [0, 1]]);
});

test('the phone turning mid-drag: touch mode keeps the pointer under the finger; trackpad mode keeps moving by the finger\'s travel', t => {
  {
    const f = touchFixture(t, { mode: 'touch' });
    f.slide(150, 250, 40, 0, { keep: true });
    Object.assign(f.viewport, { scale: 0.55, ox: 70, oy: 0 });
    f.advance(16); f.move(1, 420, 200);
    f.advance(16); f.up(1);
    f.advance(500);
    const h = f.host(), up = h.events.find(e => e.type === 'up');
    assert.deepEqual([up.x, up.y].map(Math.round), [Math.round((420 - 70) / (1280 * 0.55) * 1280), Math.round(200 / (720 * 0.55) * 720)]);
    assert.deepEqual(h.held, []);
  }
  {
    const f = touchFixture(t);
    f.slide(150, 250, 40, 0, { keep: true });
    const before = f.touch.cursor.nx;
    Object.assign(f.viewport, { scale: 0.55, ox: 70, oy: 0 });
    f.advance(16); f.move(1, 150 + 40 + 10, 250);
    f.advance(16); f.up(1);
    const step = (f.touch.cursor.nx - before) * 1280 * 0.55;
    assert.ok(step > 10 && step < 30, `a 10 px slide moves the pointer 15 to 26 px on screen (${step.toFixed(1)})`);
    assert.deepEqual(f.host().presses, []);
  }
});

test('view only: nothing is sent, and once control is back the first press goes where the pointer is shown', t => {
  const f = touchFixture(t);
  f.state.allowed = false;
  f.tap(X, Y); f.advance(600);
  f.slide(X, Y, 60, 20); f.advance(600);
  f.two(X, Y, 0, -100); f.advance(2000);
  assert.deepEqual(f.sent, []);
  f.state.allowed = true;
  f.tap(X, Y);
  f.advance(500);
  const n = f.touch.cursor, press = f.host().events.find(e => e.type === 'down');
  assert.deepEqual([press.x, press.y].map(Math.round), [Math.round(n.nx * 1280), Math.round(n.ny * 720)]);
});
