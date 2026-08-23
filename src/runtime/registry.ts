/**
 * Plugin registry: the authoritative set of live runtimes, keyed by plugin
 * name. Counts derive from manifests so CLI help and metrics can never drift
 * from what is actually loaded. See src/runtime/types.ts for RegistryCounts.
 */

import type { RegistryCounts } from "./types.js";
import type { PluginRuntime } from "./pluginRuntime.js";

export class PluginRegistry {
  readonly #runtimes = new Map<string, PluginRuntime>();

  register(runtime: PluginRuntime): void {
    const name = runtime.name;
    if (this.#runtimes.has(name)) {
      throw new Error(`plugin "${name}" is already registered`);
    }
    this.#runtimes.set(name, runtime);
  }

  unregister(name: string): boolean {
    return this.#runtimes.delete(name);
  }

  get(name: string): PluginRuntime | undefined {
    return this.#runtimes.get(name);
  }

  all(): PluginRuntime[] {
    return [...this.#runtimes.values()];
  }

  counts(): RegistryCounts {
    const plugins = this.all().map((runtime) => ({
      plugin: runtime.name,
      commands: runtime.manifest.commands.length,
      listeners: runtime.manifest.listeners.length,
      jobs: runtime.manifest.jobs.length,
    }));
    return { plugins };
  }
}
