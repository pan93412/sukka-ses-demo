import { useCallback, useMemo, useSyncExternalStore } from "react";
import stableHash from "stable-hash";

/**
 * The state of a Resource.
 */
type ResourceState<Data> = {
  data?: Data;
  error?: unknown;
  isLoading: boolean;
  isValidating: boolean;
};

/**
 * Configuration options for Resource.
 */
type ResourceOptions<Data> = {
  dedupingInterval?: number;
  revalidateOnFocus?: boolean;
  revalidateOnReconnect?: boolean;
  onSuccess?: (data: Data) => void;
  onError?: (error: Error) => void;
};

type Listener = () => void;

/**
 * Cache entry for a specific args combination.
 */
type CacheEntry<Data, Args extends unknown[]> = {
  args: Args;
  state: ResourceState<Data>;
  fetchPromise: Promise<Data> | null;
  lastFetchTime: number;
  listeners: Set<Listener>;
};

/**
 * Mutate arguments.
 */
export type MutateOptions<Data, Args extends unknown[]> =
  | {
      args: Args;
    }
  | {
      args: Args;
      newData:
        | Data
        | Promise<Data>
        | ((current?: Data) => Data | Promise<Data>);
    }
  | {
      revalidateAll: true;
    };

/**
 * Creates a FLUX-ready Resource.
 */
export function createResource<Data, Args extends unknown[]>(
  fetcher: (...args: Args) => Promise<Data>,
  options: ResourceOptions<Data> = {},
) {
  // Multi-cache: Map from stableHash(args) → CacheEntry
  const cache = new Map<string, CacheEntry<Data, Args>>();

  // Global listeners for revalidateOnFocus/Reconnect
  const globalListeners = new Set<Listener>();

  // Helper: Get or create cache entry for given args
  const getCacheEntry = (args: Args): CacheEntry<Data, Args> => {
    const key = stableHash(args);

    if (!cache.has(key)) {
      cache.set(key, {
        args,
        state: {
          isLoading: false,
          isValidating: false,
        },
        fetchPromise: null,
        lastFetchTime: 0,
        listeners: new Set<Listener>(),
      });
    }

    return cache.get(key)!;
  };

  // Notifies listeners for a specific cache entry
  const notifyEntry = (entry: CacheEntry<Data, Args>) => {
    entry.listeners.forEach((listener) => listener());
  };

  // Notifies all global listeners (for revalidateOnFocus/Reconnect)
  const notifyGlobal = () => {
    globalListeners.forEach((listener) => listener());
  };

  // Updates state for specific cache entry and notifies its subscribers
  const setEntryState = (
    entry: CacheEntry<Data, Args>,
    partial: Partial<ResourceState<Data>>,
  ) => {
    entry.state = { ...entry.state, ...partial };
    notifyEntry(entry);
  };

  // Executes data fetching for specific args
  const fetchData = async (
    args: Args,
    isRevalidating = false,
  ): Promise<Data> => {
    const entry = getCacheEntry(args);
    const now = Date.now();
    const dedupingInterval = options.dedupingInterval ?? 2000;

    // Deduplication: reuse existing promise for this specific args
    if (
      entry.fetchPromise &&
      !isRevalidating &&
      now - entry.lastFetchTime < dedupingInterval
    ) {
      return entry.fetchPromise;
    }

    entry.lastFetchTime = now;

    setEntryState(entry, {
      isLoading: entry.state.data === undefined,
      isValidating: true,
    });

    entry.fetchPromise = fetcher(...args)
      .then((data) => {
        setEntryState(entry, {
          data,
          error: undefined,
          isLoading: false,
          isValidating: false,
        });
        options.onSuccess?.(data);
        return data;
      })
      .catch((error) => {
        setEntryState(entry, {
          error,
          isLoading: false,
          isValidating: false,
        });
        options.onError?.(error);
        throw error;
      })
      .finally(() => {
        // Clears promise cache (after deduplication interval)
        setTimeout(() => {
          if (entry.fetchPromise === entry.fetchPromise) {
            entry.fetchPromise = null;
          }
        }, dedupingInterval);
      });

    return entry.fetchPromise;
  };

  // Resource object
  const resource = {
    // Returns a subscribe function for specific args (for useSyncExternalStore)
    getSubscribe(args: Args) {
      return (listener: Listener) => {
        const entry = getCacheEntry(args);
        entry.listeners.add(listener);
        globalListeners.add(listener);

        return () => {
          entry.listeners.delete(listener);
          globalListeners.delete(listener);

          // Cleanup: Remove cache entry if no listeners after 5 min
          if (entry.listeners.size === 0) {
            const key = stableHash(args);
            setTimeout(
              () => {
                const current = cache.get(key);
                if (current && current.listeners.size === 0) {
                  cache.delete(key);
                }
              },
              5 * 60 * 1000,
            );
          }
        };
      };
    },

    // Get snapshot for specific args
    getSnapshot(args: Args): ResourceState<Data> {
      const entry = getCacheEntry(args);
      return entry.state;
    },

    // SSR support: server snapshot (args-agnostic)
    getServerSnapshot(): ResourceState<Data> {
      return {
        isLoading: true,
        isValidating: false,
      };
    },

    // Manually triggers data fetching (revalidation)
    async mutate(
      options?: MutateOptions<Data, Args>,
    ): Promise<Data | undefined> {
      // No options or revalidateAll: revalidate all caches
      if (!options || ("revalidateAll" in options && options.revalidateAll)) {
        const promises: Promise<Data>[] = [];
        for (const entry of cache.values()) {
          promises.push(fetchData(entry.args, true));
        }
        await Promise.allSettled(promises);
        return undefined;
      }

      // Has args: operate on specific cache
      if ("args" in options) {
        const { args } = options;
        const entry = getCacheEntry(args);

        // If new data is provided, update directly
        if ("newData" in options) {
          const newData = options.newData;
          const awaitableData =
            typeof newData === "function"
              ? (newData as Function)(entry.state.data)
              : newData;

          setEntryState(entry, { isValidating: true });
          try {
            const data = await awaitableData;
            setEntryState(entry, {
              data,
              error: undefined,
              isLoading: false,
              isValidating: false,
            });
            return data;
          } catch (error) {
            setEntryState(entry, {
              error,
              isLoading: false,
              isValidating: false,
            });
            throw error;
          }
        }

        // Otherwise re-fetch
        return fetchData(args, true);
      }

      return undefined;
    },

    // Preloads data for specific args
    preload(args: Args): Promise<Data> {
      return fetchData(args);
    },

    // Prefill data for specific args (mainly for SSR)
    prefill(args: Args, data: Data): void {
      const entry = getCacheEntry(args);
      setEntryState(entry, {
        data,
        error: undefined,
        isLoading: false,
        isValidating: false,
      });
    },

    // Gets current data for specific args (synchronous)
    getData(args: Args): Data | undefined {
      const entry = getCacheEntry(args);
      return entry.state.data;
    },

    // Gets current error for specific args (synchronous)
    getError(args: Args): unknown | undefined {
      const entry = getCacheEntry(args);
      return entry.state.error;
    },

    // Clears data for specific args, or all if no args provided
    clear(args?: Args): void {
      if (args === undefined) {
        // Clear all caches
        cache.clear();
        notifyGlobal();
      } else {
        // Clear specific args
        const key = stableHash(args);
        const entry = cache.get(key);
        if (entry) {
          setEntryState(entry, {
            data: undefined,
            error: undefined,
            isLoading: false,
            isValidating: false,
          });
        }
      }
    },
  };

  // Set up revalidation on focus (revalidates ALL caches)
  if (options.revalidateOnFocus !== false) {
    if (typeof window !== "undefined") {
      const handleFocus = () => {
        resource.mutate({ revalidateAll: true });
      };
      window.addEventListener("focus", handleFocus);
    }
  }

  // Set up revalidation on reconnect (revalidates ALL caches)
  if (options.revalidateOnReconnect !== false) {
    if (typeof window !== "undefined") {
      const handleOnline = () => {
        resource.mutate({ revalidateAll: true });
      };
      window.addEventListener("online", handleOnline);
    }
  }

  return resource;
}

export type Resource<Data, Args extends unknown[]> = ReturnType<
  typeof createResource<Data, Args>
>;

export function useSES<Data, Args extends unknown[]>(
  resource: Resource<Data, Args>,
  args: Args,
) {
  // Get subscribe/snapshot functions bound to these specific args
  const argsHash = useMemo(() => stableHash(args), [args]);

  const subscribe = useMemo(
    () => resource.getSubscribe(args),
    [resource, argsHash],
  );

  const getSnapshot = useCallback(
    () => resource.getSnapshot(args),
    [resource, argsHash],
  );

  // Subscribe to resource using useSyncExternalStore
  const state = useSyncExternalStore(
    subscribe,
    getSnapshot,
    resource.getServerSnapshot,
  );

  // Trigger data fetching on component mount (if data is missing)
  const { data, isLoading } = state;

  const preloadIfNeeded = useCallback(() => {
    if (data === undefined && !isLoading) {
      resource.preload(args);
    }
  }, [data, isLoading, resource, argsHash]);

  // Trigger on initial render
  if (data === undefined && !isLoading) {
    preloadIfNeeded();
  }

  return state;
}
