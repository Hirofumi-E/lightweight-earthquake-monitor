import type { Earthquake } from './types';

const MAX_EARTHQUAKES = 10;
const MAX_REMEMBERED_IDS = 256;

export class EarthquakeStore {
  private earthquakes: Earthquake[] = [];
  private readonly seenIds = new Set<string>();
  private readonly idOrder: string[] = [];

  get recent(): readonly Earthquake[] {
    return this.earthquakes;
  }

  merge(incoming: readonly Earthquake[]): boolean {
    let changed = false;
    for (const earthquake of incoming) {
      if (this.seenIds.has(earthquake.id)) continue;
      this.remember(earthquake.id);
      const previous = this.earthquakes;
      const next = [...previous, earthquake]
        .sort((left, right) => right.time.localeCompare(left.time))
        .slice(0, MAX_EARTHQUAKES);
      this.earthquakes = next;
      changed ||= next.length !== previous.length || next.some((item, index) => item.id !== previous[index]?.id);
    }
    return changed;
  }

  private remember(id: string): void {
    this.seenIds.add(id);
    this.idOrder.push(id);
    if (this.idOrder.length > MAX_REMEMBERED_IDS) {
      const expiredId = this.idOrder.shift();
      if (expiredId) this.seenIds.delete(expiredId);
    }
  }
}
