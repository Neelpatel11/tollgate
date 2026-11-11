import type { AliasConfig, GatewayConfig } from '../config.js';
import type { PriceBook } from '../pricing.js';
import type { Target } from '../types.js';
import { splitTarget } from '../util/misc.js';
import type { LatencyTracker } from './latency.js';

export interface RouteTarget extends Target {
  weight: number;
}

export interface Route {
  alias: string;
  direct: boolean;
  policy: AliasConfig['policy'];
  chain: RouteTarget[];
  maxRetries: number;
  timeoutMs?: number;
  cache: AliasConfig['cache'];
}

export class Router {
  private readonly routes = new Map<string, Route>();

  constructor(
    config: GatewayConfig,
    private readonly providers: ReadonlySet<string>,
    private readonly prices: PriceBook,
    private readonly latency: LatencyTracker,
    private readonly random: () => number = Math.random,
  ) {
    for (const [alias, def] of Object.entries(config.aliases)) {
      const chain = def.chain
        .map((entry): RouteTarget => {
          const spec = typeof entry === 'string' ? { target: entry, weight: 1 } : entry;
          return { ...splitTarget(spec.target), weight: spec.weight };
        })
        .filter((t) => providers.has(t.provider));
      if (chain.length === 0) continue;
      this.routes.set(alias, {
        alias,
        direct: false,
        policy: def.policy,
        chain,
        maxRetries: def.maxRetries ?? config.server.maxRetries,
        timeoutMs: def.timeoutMs,
        cache: def.cache,
      });
    }
    this.defaultRetries = config.server.maxRetries;
  }

  private readonly defaultRetries: number;

  aliases(): string[] {
    return [...this.routes.keys()];
  }

  resolve(model: string): Route | undefined {
    const route = this.routes.get(model);
    if (route) return route;
    const idx = model.indexOf('/');
    if (idx <= 0) return undefined;
    const provider = model.slice(0, idx);
    if (!this.providers.has(provider)) return undefined;
    return {
      alias: model,
      direct: true,
      policy: 'fallback',
      chain: [{ provider, model: model.slice(idx + 1), weight: 1 }],
      maxRetries: this.defaultRetries,
      cache: { exact: 'auto', semantic: false },
    };
  }

  order(route: Route): RouteTarget[] {
    const chain = [...route.chain];
    switch (route.policy) {
      case 'lowest_latency':
        return stableSort(chain, (t) => this.latency.get(t.provider, t.model) ?? 0);
      case 'cheapest':
        return stableSort(chain, (t) => this.prices.blendedRate(t.provider, t.model));
      case 'weighted':
        return this.weightedShuffle(chain);
      default:
        return chain;
    }
  }

  private weightedShuffle(items: RouteTarget[]): RouteTarget[] {
    const pool = [...items];
    const out: RouteTarget[] = [];
    while (pool.length > 0) {
      const total = pool.reduce((sum, t) => sum + t.weight, 0);
      let roll = this.random() * total;
      let pick = 0;
      for (let i = 0; i < pool.length; i++) {
        roll -= pool[i]!.weight;
        if (roll <= 0) {
          pick = i;
          break;
        }
      }
      out.push(pool.splice(pick, 1)[0]!);
    }
    return out;
  }
}

function stableSort<T>(items: T[], key: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((a, b) => a.k - b.k || a.index - b.index)
    .map((x) => x.item);
}
