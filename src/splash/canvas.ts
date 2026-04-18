export interface SplashCanvas {
  readonly el: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
}

export function initCanvas(id: string): SplashCanvas {
  const el = document.getElementById(id) as HTMLCanvasElement;
  const ctx = el.getContext('2d')!;
  const resize = (): void => {
    el.width = window.innerWidth;
    el.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);
  return { el, ctx };
}
