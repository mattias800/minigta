/**
 * Keyboard + mouse state with per-frame edge detection. Call `endFrame()` once per frame after
 * all systems have read input.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private mouseButtons = 0;
  private mousePressed = 0;
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** Set by the owner; when false, all queries report nothing (e.g. while paused). */
  enabled = true;
  private lockedAt = 0;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseButtons = 0;
    });
    element.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
      this.mousePressed |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });
    document.addEventListener('pointerlockchange', () => {
      this.lockedAt = performance.now();
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      // Browsers sometimes report a huge bogus delta right after locking; drop it.
      if (performance.now() - this.lockedAt < 300) return;
      if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.pointerLocked) this.wheel += Math.sign(e.deltaY);
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  requestPointerLock() {
    // Unadjusted movement avoids OS mouse acceleration where supported.
    const el = this.element as HTMLElement & { requestPointerLock(opts?: object): Promise<void> | void };
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && 'catch' in p) p.catch(() => el.requestPointerLock());
    } catch {
      el.requestPointerLock();
    }
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.enabled && this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.enabled && this.released.has(code);
  }

  /** 0 = left, 2 = right. */
  isMouseDown(button: number): boolean {
    return this.enabled && (this.mouseButtons & (1 << button)) !== 0;
  }

  wasMousePressed(button: number): boolean {
    return this.enabled && (this.mousePressed & (1 << button)) !== 0;
  }

  /** -1..1 on an axis from two keys. */
  axis(negative: string[], positive: string[]): number {
    let v = 0;
    if (positive.some((k) => this.isDown(k))) v += 1;
    if (negative.some((k) => this.isDown(k))) v -= 1;
    return v;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}
