import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { wasm } from '@nockbox/iris-sdk';
import { getGrpcClient } from '../utils/wasm-cleanup';

interface WalletState {
  pkh: string | null;
  grpcEndpoint: string | null;

  setWallet: (pkh: string, grpcEndpoint: string) => Promise<void>;
  clearWallet: () => void;
  getGrpcClient: () => Promise<wasm.GrpcClient>;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      pkh: null,
      grpcEndpoint: null,

      setWallet: async (pkh: string, grpcEndpoint: string) => {
        // Only store primitive values - never store WASM objects
        set({ pkh, grpcEndpoint });
      },

      clearWallet: () => {
        set({ pkh: null, grpcEndpoint: null });
      },

      getGrpcClient: async () => {
        const state = get();
        if (!state.grpcEndpoint) {
          throw new Error('gRPC endpoint not set');
        }
        
        // Singleton GrpcClient - same instance reused, preventing WASM closure errors
        return getGrpcClient(state.grpcEndpoint);
      },
    }),
    {
      name: 'wallet-storage',
      partialize: (state) => ({
        pkh: state.pkh,
        grpcEndpoint: state.grpcEndpoint,
      }),
    }
  )
);

