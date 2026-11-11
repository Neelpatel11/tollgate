import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Usage } from './types.js';

const priceEntry = z.object({
  provider: z.string(),
  model: z.string(),
  input_per_mtok: z.number().min(0),
  output_per_mtok: z.number().min(0),
  cached_input_per_mtok: z.number().min(0).optional(),
  effective_from: z.string().default('1970-01-01'),
});

const priceFile = z.object({ prices: z.array(priceEntry) });

export type PriceEntry = z.infer<typeof priceEntry>;

export interface CostResult {
  usd: number;
  priced: boolean;
}

export class PriceBook {
  private readonly byKey = new Map<string, PriceEntry[]>();

  constructor(entries: PriceEntry[]) {
    for (const entry of entries) {
      const key = `${entry.provider}/${entry.model}`;
      const list = this.byKey.get(key) ?? [];
      list.push(entry);
      list.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      this.byKey.set(key, list);
    }
  }

  static fromFile(path: string): PriceBook {
    return new PriceBook(priceFile.parse(parseYaml(readFileSync(path, 'utf8'))).prices);
  }

  static empty(): PriceBook {
    return new PriceBook([]);
  }

  lookup(provider: string, model: string, at: Date = new Date()): PriceEntry | undefined {
    const day = at.toISOString().slice(0, 10);
    let candidates = this.byKey.get(`${provider}/${model}`);
    if (!candidates) {
      let best: string | undefined;
      for (const key of this.byKey.keys()) {
        const prefix = `${provider}/`;
        if (!key.startsWith(prefix)) continue;
        const known = key.slice(prefix.length);
        if (model.startsWith(known) && (!best || known.length > best.length)) best = known;
      }
      if (best) candidates = this.byKey.get(`${provider}/${best}`);
    }
    if (!candidates) return undefined;
    let chosen: PriceEntry | undefined;
    for (const entry of candidates) {
      if (entry.effective_from <= day) chosen = entry;
    }
    return chosen;
  }

  cost(provider: string, model: string, usage: Usage | undefined, at: Date = new Date()): CostResult {
    if (!usage) return { usd: 0, priced: false };
    const price = this.lookup(provider, model, at);
    if (!price) return { usd: 0, priced: false };
    const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, usage.prompt_tokens);
    const fresh = usage.prompt_tokens - cached;
    const cachedRate = price.cached_input_per_mtok ?? price.input_per_mtok;
    const usd =
      (fresh * price.input_per_mtok + cached * cachedRate + usage.completion_tokens * price.output_per_mtok) /
      1_000_000;
    return { usd, priced: true };
  }

  blendedRate(provider: string, model: string): number {
    const price = this.lookup(provider, model);
    if (!price) return 0;
    return 0.75 * price.input_per_mtok + 0.25 * price.output_per_mtok;
  }
}
