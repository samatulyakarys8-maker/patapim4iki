import { BREAK_WIDGET_DEFAULTS } from './break-mode.js';

export function createBreakModeWidget({
  root,
  canvas,
  scoreEl,
  bestEl,
  restartButton,
  statusEl
}) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, Math.floor(globalThis.devicePixelRatio || 1));
  let width = 320;
  let height = BREAK_WIDGET_DEFAULTS.minHeight;

  const state = {
    visible: false,
    running: false,
    gameOver: false,
    birdY: BREAK_WIDGET_DEFAULTS.minHeight / 2,
    velocity: 0,
    frame: 0,
    score: 0,
    best: Number(localStorage.getItem('break-mode-best') || 0),
    pipes: [],
    rafId: 0,
    resizeRaf: 0
  };

  bestEl.textContent = String(state.best);

  function resizeCanvas() {
    const nextWidth = Math.max(280, Math.floor(canvas.clientWidth || root.clientWidth || 320));
    const nextHeight = Math.max(
      BREAK_WIDGET_DEFAULTS.minHeight,
      Math.floor(canvas.clientHeight || root.clientHeight - 140 || BREAK_WIDGET_DEFAULTS.minHeight)
    );
    const previousHeight = height;
    width = nextWidth;
    height = nextHeight;
    dpr = Math.max(1, Math.floor(globalThis.devicePixelRatio || 1));
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (previousHeight > 0) {
      state.birdY = Math.max(24, Math.min(height - 28, (state.birdY / previousHeight) * height));
    }
    draw();
  }

  function queueResize() {
    cancelAnimationFrame(state.resizeRaf);
    state.resizeRaf = requestAnimationFrame(resizeCanvas);
  }

  function updateHud() {
    scoreEl.textContent = String(state.score);
    bestEl.textContent = String(state.best);
    restartButton.hidden = !state.gameOver;
    statusEl.textContent = state.gameOver
      ? 'Игра окончена'
      : state.running
        ? 'Клик или пробел'
        : 'Нажмите для старта';
  }

  function reset() {
    state.running = false;
    state.gameOver = false;
    state.birdY = height / 2;
    state.velocity = 0;
    state.frame = 0;
    state.score = 0;
    state.pipes = [];
    updateHud();
    draw();
  }

  function spawnPipe() {
    const gap = BREAK_WIDGET_DEFAULTS.pipeGap;
    const minTop = 26;
    const maxTop = height - gap - 34;
    const topHeight = Math.max(minTop, Math.min(maxTop, 30 + Math.random() * (height - gap - 60)));
    state.pipes.push({
      x: width + 42,
      topHeight,
      passed: false
    });
  }

  function jump() {
    if (!state.visible) return;
    if (state.gameOver) {
      reset();
      state.running = true;
      updateHud();
      return;
    }
    state.running = true;
    state.velocity = BREAK_WIDGET_DEFAULTS.flapVelocity;
    updateHud();
  }

  function collide(pipe) {
    const birdX = 56;
    const birdSize = 18;
    const pipeWidth = BREAK_WIDGET_DEFAULTS.pipeWidth;
    const gapTop = pipe.topHeight;
    const gapBottom = pipe.topHeight + BREAK_WIDGET_DEFAULTS.pipeGap;

    const overlapsX = birdX + birdSize > pipe.x && birdX < pipe.x + pipeWidth;
    const hitsTop = state.birdY < gapTop;
    const hitsBottom = state.birdY + birdSize > gapBottom;
    return overlapsX && (hitsTop || hitsBottom);
  }

  function stopGame() {
    state.gameOver = true;
    state.running = false;
    state.best = Math.max(state.best, state.score);
    localStorage.setItem('break-mode-best', String(state.best));
    updateHud();
  }

  let lastTime = 0;
  const frameTime = 1000 / 60;

  function tick(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const elapsed = timestamp - lastTime;

    if (state.visible && state.running && !state.gameOver) {
      if (elapsed >= frameTime) {
        lastTime = timestamp - (elapsed % frameTime);
        
        state.frame += 1;
        state.velocity += BREAK_WIDGET_DEFAULTS.gravity;
        state.birdY += state.velocity;

        if (state.frame % BREAK_WIDGET_DEFAULTS.spawnEveryFrames === 0) {
          spawnPipe();
        }

        state.pipes = state.pipes.filter((pipe) => pipe.x + BREAK_WIDGET_DEFAULTS.pipeWidth > -10);
        for (const pipe of state.pipes) {
          pipe.x -= BREAK_WIDGET_DEFAULTS.pipeSpeed;
          if (!pipe.passed && pipe.x + BREAK_WIDGET_DEFAULTS.pipeWidth < 56) {
            pipe.passed = true;
            state.score += 1;
            updateHud();
          }
          if (collide(pipe)) {
            stopGame();
          }
        }

        if (state.birdY < 0 || state.birdY + 18 > height - 10) {
          stopGame();
        }
      }
    } else {
      lastTime = timestamp;
    }

    draw();
    state.rafId = requestAnimationFrame(tick);
  }

  function drawBackground() {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#16324f');
    gradient.addColorStop(1, '#0a1624');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let index = 0; index < 6; index += 1) {
      ctx.beginPath();
      ctx.arc(42 + index * 48, 26 + (index % 2) * 12, 10 + (index % 3) * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPipes() {
    ctx.fillStyle = '#1ec28b';
    for (const pipe of state.pipes) {
      ctx.fillRect(pipe.x, 0, BREAK_WIDGET_DEFAULTS.pipeWidth, pipe.topHeight);
      ctx.fillRect(
        pipe.x,
        pipe.topHeight + BREAK_WIDGET_DEFAULTS.pipeGap,
        BREAK_WIDGET_DEFAULTS.pipeWidth,
        height - pipe.topHeight - BREAK_WIDGET_DEFAULTS.pipeGap
      );
    }
  }

  function drawGround() {
    ctx.fillStyle = '#0f2236';
    ctx.fillRect(0, height - 10, width, 10);
  }

  function drawBird() {
    const x = 56;
    ctx.save();
    ctx.translate(x, state.birdY);
    ctx.rotate(Math.max(-0.4, Math.min(0.55, state.velocity * 0.08)));
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(0, 0, 18, 14);
    ctx.fillStyle = '#fb8500';
    ctx.fillRect(13, 4, 8, 4);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(12, 3, 2, 2);
    ctx.restore();
  }

  function drawOverlay() {
    if (state.running || state.gameOver) return;
    ctx.fillStyle = 'rgba(5, 10, 18, 0.32)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.font = '700 16px Segoe UI';
    ctx.fillText('Break Mode', width / 2, height / 2 - 4);
    ctx.font = '500 12px Segoe UI';
    ctx.fillText('Клик или пробел для старта', width / 2, height / 2 + 18);
  }

  function drawGameOver() {
    if (!state.gameOver) return;
    ctx.fillStyle = 'rgba(3, 9, 16, 0.46)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'center';
    ctx.font = '700 16px Segoe UI';
    ctx.fillText('Столкновение', width / 2, height / 2 - 6);
    ctx.font = '500 12px Segoe UI';
    ctx.fillText('Еще раз или пробел', width / 2, height / 2 + 16);
  }

  function draw() {
    drawBackground();
    drawPipes();
    drawGround();
    drawBird();
    drawOverlay();
    drawGameOver();
  }

  function show() {
    root.hidden = false;
    state.visible = true;
    queueResize();
    updateHud();
    draw();
  }

  function hide() {
    root.hidden = true;
    state.visible = false;
  }

  function destroy() {
    cancelAnimationFrame(state.rafId);
    cancelAnimationFrame(state.resizeRaf);
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    jump();
  });
  restartButton.addEventListener('click', () => {
    reset();
    state.running = true;
    updateHud();
  });
  globalThis.addEventListener('resize', queueResize);

  reset();
  resizeCanvas();
  state.rafId = requestAnimationFrame(tick);

  return {
    show,
    hide,
    jump,
    reset,
    destroy,
    isVisible() {
      return state.visible;
    }
  };
}
