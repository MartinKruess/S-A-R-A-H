export type RouteTarget = 'self' | '9b' | 'backend' | 'vision' | 'extern';

export interface ParsedRoute {
  route: RouteTarget;
  feedback: string;
}

const ROUTE_PATTERN = /^\s*\[ROUTE:(\w+)]\s*/;

export function parseRouteTag(response: string): ParsedRoute {
  const match = response.match(ROUTE_PATTERN);

  if (!match) {
    return { route: 'self', feedback: response };
  }

  const route = match[1] as RouteTarget;
  const feedback = response.slice(match[0].length);

  return { route, feedback };
}
