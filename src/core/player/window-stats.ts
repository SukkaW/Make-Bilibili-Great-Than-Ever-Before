/**
 * A sliding window of samples: at most `maxSamples`, none older than `maxAgeMs`, each weighted by
 * recency (`halfLifeMs`) times its own weight. An empty window means "unmeasured": what is not
 * used any more ages out and gets explored again, no TTL needed.
 *
 * Read far more often than written (the host model estimates every host on every scheduling
 * decision), so reads cost nothing until the samples change. Recency decays every weight by the
 * same factor as time passes, which cancels out of a weighted quantile: only an added or expired
 * sample changes a result, time alone never does. The samples live in a ring buffer, and their
 * order by value and cumulative weights are recomputed only after such a change.
 */
/** Which way a sudden change of the samples is bad news, and shows in `estimate()` at once */
export enum WorseWhen {
  /** Throughput */
  Lower = 0,
  /** Times, and ratios of times */
  Higher = 1
}

export class WindowStats {
  /** Ring buffer of samples in the order they were added: the oldest at `head`, `size` of them */
  private readonly values: Float64Array;
  private readonly times: Float64Array;
  private readonly weights: Float64Array;
  private head = 0;
  private size = 0;

  /** The samples changed since `order`, `cumulative` and `cachedEstimate` were computed */
  private stale = false;
  /** Ring slots of the samples by value, ascending */
  private readonly order: Uint16Array;
  /** Recency-weighted weight of `order[0..i]`, relative to the newest sample */
  private readonly cumulative: Float64Array;
  private cachedEstimate: number | null = null;

  constructor(
    private readonly worse: WorseWhen,
    maxSamples = 24,
    private readonly maxAgeMs = 45 * 1000,
    private readonly halfLifeMs = 15 * 1000
  ) {
    this.values = new Float64Array(maxSamples);
    this.times = new Float64Array(maxSamples);
    this.weights = new Float64Array(maxSamples);
    this.order = new Uint16Array(maxSamples);
    this.cumulative = new Float64Array(maxSamples);
  }

  add(value: number, now: number, weight = 1) {
    if (!Number.isFinite(value) || weight <= 0) {
      return;
    }
    const capacity = this.values.length;
    let slot: number;
    if (this.size < capacity) {
      slot = (this.head + this.size) % capacity;
      this.size++;
    } else {
      // Full: the oldest makes room
      slot = this.head;
      this.head = (this.head + 1) % capacity;
    }
    this.values[slot] = value;
    this.times[slot] = now;
    this.weights[slot] = weight;
    this.stale = true;
  }

  count(now: number): number {
    this.prune(now);
    return this.size;
  }

  /** Recency-weighted quantile, `null` when the window is empty */
  quantile(q: number, now: number): number | null {
    this.refresh(now);
    return this.size === 0 ? null : this.sortedQuantile(q);
  }

  /**
   * Weighted median, but a sudden turn for the worse shows at once: when the two latest samples
   * are both worse than the median by 2x, the better of them wins.
   */
  estimate(now: number): number | null {
    this.refresh(now);
    return this.cachedEstimate;
  }

  /** Drop the samples older than `maxAgeMs` */
  private prune(now: number) {
    const capacity = this.values.length;
    while (this.size > 0 && now - this.times[this.head] > this.maxAgeMs) {
      this.head = (this.head + 1) % capacity;
      this.size--;
      this.stale = true;
    }
  }

  /** Recompute the order, cumulative weights and estimate, if the samples changed */
  private refresh(now: number) {
    this.prune(now);
    if (!this.stale) {
      return;
    }
    this.stale = false;

    const { size, head, values, order } = this;
    if (size === 0) {
      this.cachedEstimate = null;
      return;
    }
    const capacity = values.length;

    // Insertion sort: at most a few dozen samples
    for (let i = 0; i < size; i++) {
      const slot = (head + i) % capacity;
      let j = i;
      while (j > 0 && values[order[j - 1]] > values[slot]) {
        order[j] = order[j - 1];
        j--;
      }
      order[j] = slot;
    }

    const newest = this.times[(head + size - 1) % capacity];
    let total = 0;
    for (let i = 0; i < size; i++) {
      const slot = order[i];
      total += this.weights[slot] * (0.5 ** ((newest - this.times[slot]) / this.halfLifeMs));
      this.cumulative[i] = total;
    }

    const median = this.sortedQuantile(0.5);
    this.cachedEstimate = median;
    if (size >= 2) {
      const latest = values[(head + size - 1) % capacity];
      const previous = values[(head + size - 2) % capacity];
      if (this.worse === WorseWhen.Lower) {
        if (latest < median * 0.5 && previous < median * 0.5) {
          this.cachedEstimate = Math.max(latest, previous);
        }
      } else if (latest > median * 2 && previous > median * 2) {
        this.cachedEstimate = Math.min(latest, previous);
      }
    }
  }

  /** The quantile of a fresh, non-empty window */
  private sortedQuantile(q: number): number {
    const { size, cumulative } = this;
    const target = q * cumulative[size - 1];
    for (let i = 0; i < size; i++) {
      if (cumulative[i] >= target) {
        return this.values[this.order[i]];
      }
    }
    return this.values[this.order[size - 1]];
  }
}
