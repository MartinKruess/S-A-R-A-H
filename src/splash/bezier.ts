export type Point = [number, number];

export interface StreakPath {
  start: Point;
  control: Point;
  end: Point;
}

export function quadraticBezier(t: number, p0: Point, p1: Point, p2: Point): Point {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
  ];
}

export function getStreakPath(canvas: HTMLCanvasElement): StreakPath {
  const w = canvas.width;
  const h = canvas.height;
  const centerY = h * 0.52;
  const arcDepth = h * 0.10;
  return {
    start: [w * 0.15, centerY],
    control: [w * 0.4, centerY + arcDepth],
    end: [w * 0.65, centerY],
  };
}
