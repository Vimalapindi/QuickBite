export type ReadinessCheck = () => Promise<void>;
const checks = new Map<string, ReadinessCheck>();

export function registerReadinessCheck(name: string, check: ReadinessCheck): void { checks.set(name, check); }
export function clearReadinessChecks(): void { checks.clear(); }

export interface CheckResult { name: string; ok: boolean; latencyMs: number; error?: string }

export async function runReadinessChecks(): Promise<CheckResult[]> {
  return Promise.all(
    [...checks.entries()].map(async ([name, check]): Promise<CheckResult> => {
      const start = performance.now();
      try {
        // A hung dependency must not hang the probe.
        await Promise.race([
          check(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 2s')), 2000).unref()),
        ]);
        return { name, ok: true, latencyMs: Math.round(performance.now() - start) };
      } catch (e) {
        return { name, ok: false, latencyMs: Math.round(performance.now() - start), error: e instanceof Error ? e.message : 'check failed' };
      }
    }),
  );
}
