import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WalletState {
  pkh: string | null;
  grpcEndpoint: string | null;
  setWallet: (pkh: string, grpcEndpoint: string) => void;
  clearWallet: () => void;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set) => ({
      pkh: null,
      grpcEndpoint: null,
      setWallet: (pkh: string, grpcEndpoint: string) => {
        set({ pkh, grpcEndpoint });
      },
      clearWallet: () => {
        set({ pkh: null, grpcEndpoint: null });
      },
    }),
    {
      name: 'wallet-storage',
    }
  )
);

