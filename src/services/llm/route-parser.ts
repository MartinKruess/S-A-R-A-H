export type RouteTarget = '9b' | 'backend' | 'vision' | 'extern';

/** Discriminated union — the single source of truth for what the router model said. */
export type ParsedRoute =
  | { kind: 'route'; route: RouteTarget }
  | { kind: 'action'; action: string; param: string };

const ROUTE_PATTERN = /^\s*\[ROUTE:(\w+)]\s*$/;
// Only the first two colons are structural; the param may contain more colons.
// The character class excludes ']' so nested tags can never extend the match.
const ACTION_PATTERN = /^\s*\[ACTION:([a-z_]+)(?::([^\]]*))?]\s*$/;
const VALID_ROUTES: Set<string> = new Set<string>(['9b', 'backend', 'vision', 'extern']);

export function parseRouteTag(response: string): ParsedRoute {
  const actionMatch = response.match(ACTION_PATTERN);
  if (actionMatch) {
    return {
      kind: 'action',
      action: actionMatch[1],
      param: (actionMatch[2] ?? '').trim(),
    };
  }

  const match = response.match(ROUTE_PATTERN);
  if (!match) {
    return { kind: 'route', route: '9b' };
  }
  const raw = match[1];
  const route: RouteTarget = VALID_ROUTES.has(raw) ? (raw as RouteTarget) : '9b';
  return { kind: 'route', route };
}
