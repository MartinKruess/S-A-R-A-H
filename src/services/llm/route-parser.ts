export type RouteTarget = 'self' | '9b' | 'backend' | 'vision' | 'extern';

export interface ParsedRoute {
  route: RouteTarget;
  feedback: string;
}

const ROUTE_PATTERN = /^\s*\[ROUTE:(\w+)]\s*/;
const VALID_ROUTES: Set<string> = new Set<string>(['self', '9b', 'backend', 'vision', 'extern']);

export function parseRouteTag(response: string): ParsedRoute {
  const match = response.match(ROUTE_PATTERN);

  if (!match) {
    return { route: 'self', feedback: response };
  }

  const raw = match[1];
  const route: RouteTarget = VALID_ROUTES.has(raw) ? raw as RouteTarget : 'self';
  const feedback = response.slice(match[0].length);

  return { route, feedback };
}
