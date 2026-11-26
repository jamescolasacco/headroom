// Phone gestures (web/js/input/touch.js) replayed at real speeds, checked by what the Mac host ends up doing:
// its click counts (500 ms / 5 pt), the buttons it holds, its drags and scrolling. See tests/touch-fixture.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { touchFixture } from './touch-fixture.mjs';

const X = 195, Y = 300; // a finger on a phone in portrait; the desktop is drawn 384 × 216 from (0, 200)

/** A tap, then `n - 1` more `gap` ms apart (lift to touch). */
function taps(f, n, { gap = 110, hold = 90, x = X, y = Y, jitter = 4 } = {}) {
  for (let i = 0; i < n; i++) {
    if (i) f.advance(gap);
    f.tap(x + (i % 2 ? jitter : -jitter), y + (i % 2 ? -jitter : jitter), { hold });
  }
}

test('trackpad taps click the moment the finger lifts, and the host counts tap tap / tap tap tap as double / triple clicks', t => {
  for (const n of [1, 2, 3]) {
    const f = touchFixture(t);
    taps(f, n);
    const liftAt = f.clock.now;
    f.advance(1000);
    const h = f.host();
    assert.deepEqual(h.presses, [[0, 1], [0, 2], [0, 3]].slice(0, n), `${n} taps`);
    assert.equal(h.events.filter(e => e.type === 'down').at(-1).t, liftAt, 'the click went out as the finger lifted');
    assert.deepEqual(h.held, [], 'nothing stays pressed');
    assert.deepEqual(h.drags, [0, 0]);
  }
});

test('tap, then touch and drag carries the click count: by character, word, paragraph', t => {
  for (const n of [1, 2, 3]) {
    const f = touchFixture(t);
    taps(f, n);
    f.advance(150);
    f.slide(X, Y, 70, 10);
    f.advance(1000);
    const h = f.host();
    const drag = h.events.filter(e => e.type === 'down').at(-1);
    assert.equal(drag.clickState, n, `${n} taps then drag: the drag's press counts ${n}`);
    assert.ok(h.drags[0] >= 5, 'the pointer dragged with the left button down');
    assert.deepEqual(h.held, []);
    if (n === 1) {
      assert.deepEqual(h.presses, [[0, 1], [0, 1]], 'tap then drag is a click and a separate drag, never a double click');
      const click = h.events.find(e => e.type === 'down');
      assert.ok(Math.hypot(drag.x - click.x, drag.y - click.y) >= 5, 'the drag presses 5+ points from the click');
    } else {
      assert.equal(h.presses.length, n, 'the drag carries the last tap\'s press on (no extra press)');
    }
  }
});

test('the user\'s slow taps (150 to 400 ms apart) still make double and triple clicks', t => {
  for (const gap of [150, 250, 330, 400]) {
    const f = touchFixture(t);
    taps(f, 3, { gap, hold: 90 });
    f.advance(1000);
    const h = f.host();
    // Press to press is gap + hold: within the host's 500 ms each time.
    assert.deepEqual(h.presses, [[0, 1], [0, 2], [0, 3]], `gap ${gap}`);
    assert.deepEqual(h.held, []);
  }
});

test('hold then drag is a left drag; tap and hold is a right-click; two-finger tap is a right-click', t => {
  {
    const f = touchFixture(t);
    f.slide(X, Y, 60, 0, { pause: 500 });
    f.advance(500);
    const h = f.host();
    assert.deepEqual(h.presses, [[0, 1]]);
    assert.ok(h.drags[0] >= 5);
    assert.deepEqual(h.held, []);
  }
  {
    const f = touchFixture(t);
    f.tap(X, Y, { hold: 600 });
    f.advance(500);
    assert.deepEqual(f.host().presses, [[2, 1]]);
    assert.deepEqual(f.host().held, []);
    assert.deepEqual(f.local.ripples, ['hold', 'right']);
  }
  {
    const f = touchFixture(t);
    f.two(X, Y);
    f.advance(500);
    assert.deepEqual(f.host().presses, [[2, 1]]);
    assert.deepEqual(f.host().held, []);
  }
});

test('two-finger tap, then two fingers drag: a right-click drag that ends with nothing held', t => {
  const f = touchFixture(t);
  f.two(X, Y);
  f.advance(150);
  f.two(X, Y, 60, 40);
  f.advance(500);
  const h = f.host();
  assert.deepEqual(h.presses, [[2, 1], [2, 1]], 'the drag\'s press is apart from the right-click (no double right-click)');
  assert.ok(h.drags[1] >= 5, 'moves with the right button down');
  assert.equal(h.drags[0], 0);
  assert.deepEqual(h.held, []);
});

test('two fingers scroll with momentum; a tap while it moves stops it and clicks, a two-finger tap right-clicks', t => {
  const f = touchFixture(t);
  f.two(X, Y, 0, -150);
  const lifted = f.clock.now;
  f.advance(100);
  const scrolled = f.host().wheel.y;
  assert.ok(scrolled < -600, `content follows the fingers up: the wheel scrolls down (${scrolled})`);
  assert.ok(f.host().events.some(e => e.type === 'wheel' && e.t > lifted), 'momentum continues after the fingers lift');
  f.tap(X, Y);
  const stopped = f.clock.now;
  f.advance(1500);
  assert.ok(!f.host().events.some(e => e.type === 'wheel' && e.t > stopped), 'the touch stopped the momentum');
  assert.deepEqual(f.host().presses, [[0, 1]], 'the tap that stopped it clicked too');

  const g = touchFixture(t);
  g.two(X, Y, 0, -150);
  g.advance(100);
  assert.ok(g.touch.inertia, 'still moving');
  g.two(X, Y);
  const stopped2 = g.clock.now;
  g.advance(1500);
  assert.ok(!g.host().events.some(e => e.type === 'wheel' && e.t > stopped2), 'the two fingers stopped the momentum');
  assert.deepEqual(g.host().presses, [[2, 1]], 'and right-clicked');
});

test('three-finger tap toggles the keyboard and three fingers sliding pan the view; neither reaches the computer', t => {
  const f = touchFixture(t);
  f.down(1, X - 40, Y); f.down(2, X, Y); f.down(3, X + 40, Y);
  f.advance(80);
  f.up(1); f.up(2); f.up(3);
  assert.equal(f.local.keyboard, 1);
  f.advance(500);
  f.down(1, X - 40, Y); f.down(2, X, Y); f.down(3, X + 40, Y);
  for (let i = 1; i <= 8; i++) { f.advance(16); f.move(1, X - 40, Y - 8 * i); f.move(2, X, Y - 8 * i); f.move(3, X + 40, Y - 8 * i); }
  f.advance(16);
  f.up(1); f.up(2); f.up(3);
  f.advance(500);
  assert.ok(f.local.pan.reduce((s, [, dy]) => s + dy, 0) < -30, 'the view panned with the fingers');
  assert.equal(f.local.keyboard, 1, 'a slide isn\'t a tap');
  assert.deepEqual(f.host().events.filter(e => e.type !== 'moved'), []);
});

test('touch mode: a tap clicks under the finger, tap tap double-clicks there, a hold right-clicks there, a drag drags from where it landed', t => {
  const at = (f, x, y) => ({ x: (x - f.viewport.ox) / (f.viewport.encW * f.viewport.scale) * 1280, y: (y - f.viewport.oy) / (f.viewport.encH * f.viewport.scale) * 720 });
  {
    const f = touchFixture(t, { mode: 'touch' });
    taps(f, 2, { jitter: 5 });
    f.advance(1000);
    const h = f.host(), p = at(f, X - 5, Y + 5);
    assert.deepEqual(h.presses, [[0, 1], [0, 2]], 'the second tap lands where the first did');
    assert.ok(h.events.filter(e => e.type === 'down').every(e => Math.abs(e.x - p.x) < 1 && Math.abs(e.y - p.y) < 1));
  }
  {
    const f = touchFixture(t, { mode: 'touch' });
    f.tap(250, 260, { hold: 600 });
    f.advance(500);
    const h = f.host(), p = at(f, 250, 260);
    assert.deepEqual(h.presses, [[2, 1]]);
    assert.ok(Math.abs(h.events[h.events.length - 1].x - p.x) < 1);
  }
  {
    const f = touchFixture(t, { mode: 'touch' });
    f.slide(150, 250, 90, 30);
    f.advance(500);
    const h = f.host(), from = at(f, 150, 250), to = at(f, 240, 280);
    const press = h.events.find(e => e.type === 'down'), release = h.events.find(e => e.type === 'up');
    assert.ok(Math.abs(press.x - from.x) < 1 && Math.abs(press.y - from.y) < 1, 'pressed where the finger landed');
    assert.ok(Math.abs(release.x - to.x) < 1 && Math.abs(release.y - to.y) < 1, 'released where it lifted');
    assert.deepEqual(h.held, []);
  }
});

test('trackpad mode: a tap clicks where the pointer is shown, also after the computer moved it', t => {
  const f = touchFixture(t);
  f.slide(X, Y, 60, 0);
  f.advance(1000);
  // Someone at the computer moves the mouse; its reports arrive here and the pointer is drawn there.
  f.cursor.setPosition(100, 100);
  f.touch.remoteCursor(100 / 1280, 100 / 720);
  f.tap(X, Y);
  f.advance(500);
  const press = f.host().events.find(e => e.type === 'down');
  assert.deepEqual([press.x, press.y].map(Math.round), [100, 100]);
});

test('lifting one finger of a pinch and putting it back zooms on without a jump', t => {
  const f = touchFixture(t);
  f.down(1, 150, 300); f.down(2, 250, 300);
  for (let i = 1; i <= 5; i++) { f.advance(16); f.move(1, 150 - 4 * i, 300); f.move(2, 250 + 4 * i, 300); }
  f.advance(16);
  f.up(2);
  f.advance(100);
  f.down(3, 300, 300);
  for (let i = 1; i <= 4; i++) { f.advance(16); f.move(3, 300 + 3 * i, 300); }
  f.advance(16);
  f.up(1); f.up(3);
  assert.ok(f.local.pinch.length >= 6);
  for (const [factor, , , source, dx, dy] of f.local.pinch) {
    assert.equal(source, 'touch');
    assert.ok(Math.abs(dx) < 3 && Math.abs(dy) < 3, `the picture follows the fingers smoothly (pan ${dx}, ${dy})`);
    assert.ok(factor > 0.9 && factor < 1.25);
  }
  assert.deepEqual(f.host().events, [], 'zooming the view sends nothing');
});

test('a second finger joining a drag ends the drag and is never a two-finger tap', t => {
  for (const mode of ['touch', 'trackpad']) {
    const f = touchFixture(t, { mode });
    f.slide(X, Y, 60, 0, { keep: true });
    f.down(2, X + 100, Y);
    f.advance(30);
    f.up(1); f.up(2);
    f.advance(500);
    const h = f.host();
    assert.ok(!h.presses.some(([b]) => b === 2), `${mode}: no right-click`);
    assert.deepEqual(h.held, []);
    assert.equal(f.local.keyboard, 0);
  }
});

test('fingers after a mouse or an iPad trackpad (this device\'s own pointer showing) draw the computer\'s pointer again', t => {
  const f = touchFixture(t);
  f.cursor.setMode('css'); // a mouse moved over the picture (MouseInput)
  f.tap(X, Y);
  assert.equal(f.cursor.mode, 'overlay');
});
