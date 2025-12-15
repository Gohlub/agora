import { useEffect, useRef } from 'react';


type WasmObject = { free: () => void };

/**
 * Manages WASM object lifecycle and prevents double-free
 */
export class WasmResourceManager {
  private objects: WasmObject[] = [];
  private freedObjects = new WeakSet<WasmObject>();

  /**
   * Register a WASM object for automatic cleanup
   */
  register<T extends WasmObject>(obj: T): T {
    this.objects.push(obj);
    return obj;
  }

  /**
   * Register multiple WASM objects at once
   */
  registerAll<T extends WasmObject>(objects: T[]): T[] {
    objects.forEach(obj => this.objects.push(obj));
    return objects;
  }

  /**
   * Free all registered WASM objects in reverse order 
   */
  cleanup(): void {
    // Free in reverse order (dependencies first)
    for (let i = this.objects.length - 1; i >= 0; i--) {
      const obj = this.objects[i];
      if (obj && !this.freedObjects.has(obj)) {
        try {
          obj.free();
        } catch (error) {
            console.log(error)
          // if free() throws, the object is likely already freed
          // (e.g., freed by a parent object). Silently ignore.
        } finally {
          // Always mark as freed, even if free() threw an error
          // This prevents trying to free it again
          this.freedObjects.add(obj);
        }
      }
    }
    this.objects = [];
  }

  /**
   * Get the number of registered objects
   */
  get count(): number {
    return this.objects.length;
  }
}

/**
 * React hook for managing WASM object cleanup in components
 * Automatically cleans up on unmount
 */
export function useWasmCleanup() {
  const managerRef = useRef<WasmResourceManager | null>(null);

  // Initialize manager on first render
  if (!managerRef.current) {
    managerRef.current = new WasmResourceManager();
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (managerRef.current) {
        managerRef.current.cleanup();
      }
    };
  }, []);

  return managerRef.current;
}
