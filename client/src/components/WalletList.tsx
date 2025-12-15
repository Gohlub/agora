import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider, wasm } from '@nockbox/iris-sdk';
import { 
  checkTransactionAcceptance, 
  pollForTransactionInclusionWithCleanup,
  ACCEPTANCE_CHECK_INTERVAL_MS,
  ACCEPTANCE_CHECK_MAX_ATTEMPTS,
  INCLUSION_POLL_INTERVAL_MS,
  INCLUSION_POLL_MAX_DURATION_MS
} from '../utils/tx-lifecycle';
import { useWasmCleanup, getGrpcClient } from '../utils/wasm-cleanup';

interface WalletWithStatus {
  id: string;
  lock_root_hash: string;
  threshold: number;
  total_signers: number;
  created_at: string;
  created_by_pkh: string;
  participants?: string[]; 
  isFunded?: boolean;
  balance?: number;
  isPolling?: boolean;
  /**
   * Store protoNotes for transaction building (only when funded)
   * 
   * To propose a transaction from this multisig wallet:
   * 1. Get notes: wallet.notes (contains protoNote and assets)
   * 2. Create WASM Note objects: notes.map(n => wasm.Note.fromProtobuf(n.protoNote))
   * 3. Reconstruct multisig SpendCondition from participants/threshold
   * 4. Build transaction using the WASM Note objects and SpendCondition
   * 
   * protoNote is the raw protobuf object from gRPC (getBalanceByFirstName response).
   * It has structure: { note_version?: { V1?: { assets?: { value?: number }, ... } }, ... }
   * Type is `unknown` for type safety, but will be passed to wasm.Note.fromProtobuf() which accepts any.
   */
  notes?: Array<{ protoNote: any; assets: number }>;
}

export default function WalletList() {
  const [wallets, setWallets] = useState<WalletWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [funding, setFunding] = useState<Set<string>>(new Set());
  const [fundingAmounts, setFundingAmounts] = useState<Map<string, number>>(new Map());
  const [pollingWallets, setPollingWallets] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { pkh, grpcEndpoint } = useWalletStore();
  const pollingCleanups = useRef<Map<string, () => void>>(new Map());
  const wasmCleanup = useWasmCleanup();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    
    if (pkh && grpcEndpoint) {
      loadWallets();
    }
    
    return () => {
      isMountedRef.current = false;
      pollingCleanups.current.forEach(cleanup => cleanup());
      pollingCleanups.current.clear();
    };
  }, [pkh, grpcEndpoint]);

  const loadWallets = async () => {
    if (!pkh || !grpcEndpoint) return;
    
    try {
      setLoading(true);
      const data = await apiClient.listMultisigs(pkh);
      
      // Show wallets immediately (without balance data)
      const initialWallets: WalletWithStatus[] = data
        .filter(w => w.lock_root_hash && typeof w.lock_root_hash === 'string')
        .map(wallet => ({
          ...wallet,
          lock_root_hash: wallet.lock_root_hash,
          isFunded: undefined, // Unknown until we check
          balance: undefined,
        }));
      
      if (isMountedRef.current) {
        setWallets(initialWallets);
        setLoading(false);
      }
      
      // Then fetch balances and update each wallet as data comes in
      const grpcClient = await getGrpcClient(grpcEndpoint);
      
      for (const wallet of initialWallets) {
        if (!isMountedRef.current) return;
        
        try {
          const balance = await grpcClient.getBalanceByFirstName(wallet.lock_root_hash);
          
          const isFunded = balance?.notes && balance.notes.length > 0;
          let totalBalance = 0;
          const notes: Array<{ protoNote: any; assets: number }> = [];
          
          if (balance?.notes) {
            for (const n of balance.notes) {
              const assets = n.assets || 
                n.note?.note_version?.V1?.assets?.value || 
                n.note?.v1?.assets?.value || 
                0;
              totalBalance += Number(assets);
              notes.push({ protoNote: n.note, assets: Number(assets) });
            }
          }
          
          if (isMountedRef.current) {
            setWallets(prev => prev.map(w => 
              w.id === wallet.id 
                ? { ...w, isFunded, balance: totalBalance, notes: notes.length > 0 ? notes : undefined }
                : w
            ));
          }
        } catch (e: any) {
          console.error(`Failed to fetch balance for wallet ${wallet.id}:`, e);
        }
      }
    } catch (err: any) {
      if (isMountedRef.current) {
        setError(err.message || 'Failed to load wallets');
        setLoading(false);
      }
    }
  };

  const handleFundWallet = async (wallet: WalletWithStatus) => {
    if (!pkh || !grpcEndpoint || !wallet.lock_root_hash) {
      setError('Wallet not connected or lock root hash missing');
      return;
    }

    try {
      setFunding(new Set([...funding, wallet.id]));
      setError(null);

      const provider = new NockchainProvider();
      const grpcClient = await getGrpcClient(grpcEndpoint);

      const userPkh = wasmCleanup.register(wasm.Pkh.single(pkh));
      const userSpendCondition = wasmCleanup.register(wasm.SpendCondition.newPkh(userPkh));
      const userFirstName = wasmCleanup.register(userSpendCondition.firstName());
      const userFirstNameValue = userFirstName.value;
      const userBalance = await grpcClient.getBalanceByFirstName(userFirstNameValue);

      if (!userBalance || !userBalance.notes || userBalance.notes.length === 0) {
        throw new Error('No notes available to fund the multisig note');
      }

      // Convert notes from protobuf - these are needed for transaction building
      const notes = userBalance.notes.map((n: any) => 
        wasmCleanup.register(wasm.Note.fromProtobuf(n.note))
      );
      const note = notes[0];
      const noteAssets = note.assets;

      // get funding amount from state (default: 1 NOCK = 65536 nicks)
      const amountNock = fundingAmounts.get(wallet.id) || 1;
      const FUND_AMOUNT_NICKS = BigInt(Math.floor(amountNock * 65536));
      const feePerWord = BigInt(32768); // 0.5 NOCK per word

      if (noteAssets < FUND_AMOUNT_NICKS) {
        throw new Error(`Insufficient funds: need ${FUND_AMOUNT_NICKS} nicks, have ${noteAssets}`);
      }

      // Build transaction to create a note bound to the multisig spending condition
      const builder = wasmCleanup.register(new wasm.TxBuilder(feePerWord));

      // create lock root hash as recipient (to initialize the multisig note)
      const lockRootDigest = wasmCleanup.register(new wasm.Digest(wallet.lock_root_hash));
      const lockRoot = wasmCleanup.register(wasm.LockRoot.fromHash(lockRootDigest));

      const inputPkh = wasmCleanup.register(wasm.Pkh.single(pkh));
      const inputSpendCondition = wasmCleanup.register(wasm.SpendCondition.newPkh(inputPkh));
      
      const refundPkh = wasmCleanup.register(wasm.Pkh.single(pkh));
      const refundLock = wasmCleanup.register(wasm.SpendCondition.newPkh(refundPkh));

      // create SpendBuilder for the input note
      const spendBuilder = wasmCleanup.register(new wasm.SpendBuilder(
        notes[0],
        inputSpendCondition,
        refundLock
      ));

      // create seed that sends to lock-root hash (multisig spending condition)
      const seed = wasmCleanup.register(new wasm.Seed(
        null, // output_source
        lockRoot, // lock_root (hash)
        FUND_AMOUNT_NICKS, // gift
        wasm.NoteData.empty(), // note_data
        notes[0].hash() // parent_hash
      ));

      // add seed to spend builder
      spendBuilder.seed(seed);

      // compute refund and fee
      spendBuilder.computeRefund(false);

      // add spend to transaction builder
      builder.spend(spendBuilder);

      // recalculate and set fees
      builder.recalcAndSetFee(false);

      const nockchainTx = builder.build();
      const txId = nockchainTx.id.value;
      const rawTxProtobuf = nockchainTx.toRawTx().toProtobuf();
      const txNotes = builder.allNotes();
      const txNotesArray = txNotes.notes;
      const txSpendConditionsArray = txNotes.spendConditions;

      const signedTxProtobuf = await provider.signRawTx({
        rawTx: rawTxProtobuf,
        notes: txNotesArray,
        spendConditions: txSpendConditionsArray,
      });

      wasmCleanup.register(wasm.RawTx.fromProtobuf(signedTxProtobuf));
      await grpcClient.sendTransaction(signedTxProtobuf);

      await checkTransactionAcceptance(() => getGrpcClient(grpcEndpoint), txId, {
        intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
        maxAttempts: ACCEPTANCE_CHECK_MAX_ATTEMPTS,
      });

      startPollingForNote(wallet.id, wallet.lock_root_hash!);
    } catch (err: any) {
      setError(err.message || 'Failed to fund wallet');
      console.error('Fund wallet error:', err);
    } finally {
      setFunding(new Set([...funding].filter(id => id !== wallet.id)));
    }
  };

  const startPollingForNote = (walletId: string, lockRootHash: string) => {
    stopPollingForNote(walletId);
    
    if (!grpcEndpoint) {
      setError('gRPC endpoint not available');
      return;
    }
    
    setPollingWallets(prev => new Set([...prev, walletId]));
    
    const { promise, cleanup } = pollForTransactionInclusionWithCleanup(
      async () => {
        if (!isMountedRef.current) return false;
        
        const grpcClient = await getGrpcClient(grpcEndpoint);
        const balance = await grpcClient.getBalanceByFirstName(lockRootHash);
        return balance?.notes && balance.notes.length > 0;
      },
      {
        intervalMs: INCLUSION_POLL_INTERVAL_MS,
        maxDurationMs: INCLUSION_POLL_MAX_DURATION_MS,
        onIncluded: async () => {
          if (!isMountedRef.current) return;
          await loadWallets();
          stopPollingForNote(walletId);
        },
        onPoll: () => {},
        timeoutErrorMessage: `Transaction for wallet ${walletId} was not included within ${INCLUSION_POLL_MAX_DURATION_MS / 1000 / 60} minutes.`,
      }
    );
    
    pollingCleanups.current.set(walletId, cleanup);
    
    promise
      .then((isIncluded) => {
        if (!isMountedRef.current) return;
        if (isIncluded) stopPollingForNote(walletId);
      })
      .catch((error) => {
        if (!isMountedRef.current) return;
        console.error(`Polling failed for wallet ${walletId}:`, error);
        stopPollingForNote(walletId);
        setError(`Failed to confirm transaction inclusion: ${error.message}`);
      });
  };

  const stopPollingForNote = (walletId: string) => {
    const cleanup = pollingCleanups.current.get(walletId);
    if (cleanup) {
      cleanup();
      pollingCleanups.current.delete(walletId);
    }
    setPollingWallets(prev => {
      const next = new Set(prev);
      next.delete(walletId);
      return next;
    });
  };

  if (loading) {
    return <div>Loading wallets...</div>;
  }

  if (error) {
    return (
      <div style={{ 
        padding: '1rem', 
        backgroundColor: '#fee', 
        color: '#c33', 
        borderRadius: '4px',
        marginBottom: '1rem'
      }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Wallets</h1>
        <Link
          to="/wallets/create"
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#007bff',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '4px',
          }}
        >
          Create Wallet
        </Link>
      </div>
      {wallets.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
          <p>No wallets found. Create your first multisig wallet to get started.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {wallets.map((wallet) => {
            const isFunding = funding.has(wallet.id);
            const isLoadingBalance = wallet.isFunded === undefined;
            const isFunded = wallet.isFunded || false;
            const balance = wallet.balance || 0;
            const balanceNock = balance / 65536;

            return (
              <div
                key={wallet.id}
                style={{
                  padding: '1.5rem',
                  backgroundColor: 'white',
                  borderRadius: '8px',
                  border: `2px solid ${isFunded ? '#28a745' : '#e0e0e0'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ margin: 0 }}>{`Wallet ${wallet.id.substring(0, 8)}`}</h3>
                    <p style={{ marginTop: '0.5rem', color: '#666', fontSize: '0.875rem' }}>
                      {wallet.threshold} of {wallet.total_signers} signatures required
                    </p>
                    {isLoadingBalance ? (
                      <p style={{ 
                        marginTop: '0.5rem', 
                        color: '#999', 
                        fontSize: '0.875rem',
                        fontStyle: 'italic',
                      }}>
                        Loading balance...
                      </p>
                    ) : isFunded ? (
                      <p style={{ 
                        marginTop: '0.5rem', 
                        color: '#28a745', 
                        fontSize: '0.875rem', 
                        fontWeight: 'bold' 
                      }}>
                        ✓ Funded: {balanceNock.toFixed(4)} NOCK
                      </p>
                    ) : (
                      <p style={{ 
                        marginTop: '0.5rem', 
                        color: '#dc3545', 
                        fontSize: '0.875rem',
                        fontWeight: 'bold'
                      }}>
                        ⚠ Needs initialization - Wallet must be funded before transactions can be proposed
                      </p>
                    )}
                    {pollingWallets.has(wallet.id) && (
                      <p style={{ 
                        marginTop: '0.5rem', 
                        color: '#007bff', 
                        fontSize: '0.875rem',
                        fontStyle: 'italic'
                      }}>
                        🔄 Waiting for note confirmation...
                      </p>
                    )}
                    {wallet.lock_root_hash && (
                      <p style={{ 
                        marginTop: '0.5rem', 
                        color: '#999', 
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        wordBreak: 'break-all'
                      }}>
                        {wallet.lock_root_hash.substring(0, 20)}...
                      </p>
                    )}
                  </div>
                  {!isFunded && !isLoadingBalance && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginLeft: '1rem' }}>
                      <input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        value={fundingAmounts.get(wallet.id) || 1}
                        onChange={(e) => {
                          const amount = parseFloat(e.target.value) || 1;
                          setFundingAmounts(prev => new Map(prev).set(wallet.id, amount));
                        }}
                        placeholder="Amount (NOCK)"
                        style={{
                          padding: '0.5rem',
                          border: '1px solid #ddd',
                          borderRadius: '4px',
                          width: '120px',
                        }}
                        disabled={isFunding || pollingWallets.has(wallet.id)}
                      />
                      <button
                        onClick={() => handleFundWallet(wallet)}
                        disabled={isFunding || pollingWallets.has(wallet.id)}
                        style={{
                          padding: '0.5rem 1rem',
                          backgroundColor: (isFunding || pollingWallets.has(wallet.id)) ? '#ccc' : '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: (isFunding || pollingWallets.has(wallet.id)) ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isFunding ? 'Funding...' : pollingWallets.has(wallet.id) ? 'Waiting...' : 'Initialize Note'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

