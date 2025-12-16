import { useEffect, useRef } from 'react';
import * as wasm from '../wasm';

type WasmObject = { free: () => void };

/**
 * Singleton WASM initialization.
 */
let wasmInitialized = false;
let wasmInitializing: Promise<void> | null = null;

export async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;
  if (wasmInitializing) return wasmInitializing;
  
  wasmInitializing = (async () => {
    await wasm.default();
    wasmInitialized = true;
  })();
  
  return wasmInitializing;
}

/**
 * Singleton GrpcClient per endpoint.
 * 
 * This prevents WASM closure errors by ensuring only one GrpcClient exists
 * per endpoint.
 * 
 */
const grpcClients = new Map<string, wasm.GrpcClient>();
const grpcClientPromises = new Map<string, Promise<wasm.GrpcClient>>();

export async function getGrpcClient(endpoint: string): Promise<wasm.GrpcClient> {
  // Return existing client if we have one
  const existing = grpcClients.get(endpoint);
  if (existing) return existing;
  
  // If we're already creating one, wait for it
  const inProgress = grpcClientPromises.get(endpoint);
  if (inProgress) return inProgress;
  
  // Create new client (only one creation per endpoint ever runs)
  const promise = (async () => {
    await ensureWasmInitialized();
    const client = new wasm.GrpcClient(endpoint);
    grpcClients.set(endpoint, client);
    grpcClientPromises.delete(endpoint);
    return client;
  })();
  
  grpcClientPromises.set(endpoint, promise);
  return promise;
}

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
        } catch {
          // Object likely already freed by a parent - ignore
        } finally {
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
