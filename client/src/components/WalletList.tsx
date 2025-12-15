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

  useEffect(() => {
    if (pkh && grpcEndpoint) {
      loadWallets();
    }
    
    // stop polling 
    return () => {
      pollingCleanups.current.forEach(cleanup => cleanup());
      pollingCleanups.current.clear();
    };
  }, [pkh, grpcEndpoint]);

  const loadWallets = async () => {
    if (!pkh || !grpcEndpoint) return;
    try {
      setLoading(true);
      const data = await apiClient.listMultisigs(pkh);
      
      // Check funding status for locks
      await wasm.default();
      const grpcClient = new wasm.GrpcClient(grpcEndpoint);
      
      const walletsWithStatus: WalletWithStatus[] = await Promise.all(
        data.map(async (wallet: any) => {
          try {
            const lockRootHash = wallet.lock_root_hash;
            
            if (!lockRootHash) {
              throw new Error('Wallet missing lock_root_hash');
            }
            
            // check if notes exist for this spending condition 
            const balance = await grpcClient.getBalanceByFirstName(lockRootHash);
            const isFunded = balance?.notes && balance.notes.length > 0;
            let totalBalance = 0;
            if (balance?.notes) {
              for (const n of balance.notes) {
                const note = wasm.Note.fromProtobuf(n.note);
                totalBalance += Number(note.assets);
                note.free();
              }
            }
            
            return {
              ...wallet,
              lock_root_hash: lockRootHash,
              isFunded,
              balance: totalBalance,
            };
          } catch (e) {
            console.error(`Failed to process wallet ${wallet.id}:`, e);
            return {
              ...wallet,
              lock_root_hash: wallet.lock_root_hash || '',
              isFunded: false,
              balance: 0,
            };
          }
        })
      );
      
      setWallets(walletsWithStatus);
    } catch (err: any) {
      setError(err.message || 'Failed to load wallets');
    } finally {
      setLoading(false);
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

      await wasm.default();
      const provider = new NockchainProvider();
      const grpcClient = new wasm.GrpcClient(grpcEndpoint);

      // collect info to fund the multisig wallet
      const userPkh = wasm.Pkh.single(pkh);
      const userSpendCondition = wasm.SpendCondition.newPkh(userPkh);
      const userFirstName = userSpendCondition.firstName();
      const userBalance = await grpcClient.getBalanceByFirstName(userFirstName.value);
      userSpendCondition.free();
      userPkh.free();

      if (!userBalance || !userBalance.notes || userBalance.notes.length === 0) {
        throw new Error('No notes available to fund the multisig note');
      }

      // convert notes from protobuf
      const notes = userBalance.notes.map((n: any) => wasm.Note.fromProtobuf(n.note));
      const note = notes[0];
      const noteAssets = note.assets;

      // get funding amount from state (default: 1 NOCK = 65536 nicks)
      const amountNock = fundingAmounts.get(wallet.id) || 1;
      const FUND_AMOUNT_NICKS = BigInt(Math.floor(amountNock * 65536));
      const feePerWord = BigInt(32768); // 0.5 NOCK per word

      if (noteAssets < FUND_AMOUNT_NICKS) {
        throw new Error(`Insufficient funds: need ${FUND_AMOUNT_NICKS} nicks, have ${noteAssets}`);
      }

      // vuild transaction to create a note bound to the multisig spending condition
      const builder = new wasm.TxBuilder(feePerWord);

      // create lock root hash as recipient (to initialize the multisig note)
      const lockRootDigest = new wasm.Digest(wallet.lock_root_hash);
      const lockRoot = wasm.LockRoot.fromHash(lockRootDigest);

      // recreate user's spend condition for the input note
      const inputPkh = wasm.Pkh.single(pkh);
      const inputSpendCondition = wasm.SpendCondition.newPkh(inputPkh);
      
      // create refund lock (user's PKH)
      const refundPkh = wasm.Pkh.single(pkh);
      const refundLock = wasm.SpendCondition.newPkh(refundPkh);

      // create SpendBuilder for the input note
      const spendBuilder = new wasm.SpendBuilder(
        notes[0],
        inputSpendCondition,
        refundLock
      );

      // create seed that sends to lock-root hash (multisig spending condition)
      const seed = new wasm.Seed(
        null, // output_source
        lockRoot, // lock_root (hash)
        FUND_AMOUNT_NICKS, // gift
        wasm.NoteData.empty(), // note_data
        notes[0].hash() // parent_hash
      );

      // add seed to spend builder
      spendBuilder.seed(seed);

      // compute refund and fee
      spendBuilder.computeRefund(false);

      // add spend to transaction builder
      builder.spend(spendBuilder);

      // recalculate and set fees
      builder.recalcAndSetFee(false);

      // build the transaction
      const nockchainTx = builder.build();
      const txId = nockchainTx.id.value; // Get transaction ID before signing
      const rawTxProtobuf = nockchainTx.toRawTx().toProtobuf();
      const txNotes = builder.allNotes();

      // sign using iris provider
      const signedTxProtobuf = await provider.signRawTx({
        rawTx: rawTxProtobuf,
        notes: txNotes.notes,
        spendConditions: txNotes.spendConditions,
      });

      // broadcast transaction
      const signedTx = wasm.RawTx.fromProtobuf(signedTxProtobuf);
      await grpcClient.sendTransaction(signedTxProtobuf);

      // verify transaction was accepted into mempool before polling for inclusion
      await checkTransactionAcceptance(grpcClient, txId, {
        intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
        maxAttempts: ACCEPTANCE_CHECK_MAX_ATTEMPTS,
      });

      // Clean up 
      signedTx.free();
      builder.free();
      notes.forEach((n: wasm.Note) => n.free());
      lockRootDigest.free();
      lockRoot.free();
      inputPkh.free();
      inputSpendCondition.free();
      refundPkh.free();
      refundLock.free();
      spendBuilder.free();
      seed.free();

      // transaction accepted - start polling for note inclusion
      startPollingForNote(wallet.id, wallet.lock_root_hash!);
    } catch (err: any) {
      setError(err.message || 'Failed to fund wallet');
      console.error('Fund wallet error:', err);
    } finally {
      setFunding(new Set([...funding].filter(id => id !== wallet.id)));
    }
  };

  const startPollingForNote = (walletId: string, lockRootHash: string) => {
    // stop any existing polling for this wallet
    stopPollingForNote(walletId);
    
    if (!grpcEndpoint) {
      setError('gRPC endpoint not available');
      return;
    }
    
    // Mark as polling
    setPollingWallets(prev => new Set([...prev, walletId]));
    
    const { promise, cleanup } = pollForTransactionInclusionWithCleanup(
      async () => {
        await wasm.default();
        const grpcClient = new wasm.GrpcClient(grpcEndpoint);
        const balance = await grpcClient.getBalanceByFirstName(lockRootHash);
        
        const isFunded = balance?.notes && balance.notes.length > 0;
        
        // Clean up note objects if they exist
        if (balance?.notes) {
          for (const n of balance.notes) {
            const note = wasm.Note.fromProtobuf(n.note);
            note.free();
          }
        }
        
        return isFunded;
      },
      {
        intervalMs: INCLUSION_POLL_INTERVAL_MS,
        maxDurationMs: INCLUSION_POLL_MAX_DURATION_MS,
        onIncluded: async () => {
          // Note found - reload wallets to update UI
          await loadWallets();
          stopPollingForNote(walletId);
        },
        onPoll: (attempt) => {
          // Optional: log polling progress
          if (attempt % 6 === 0) { // Log every minute (6 attempts * 10s = 60s)
            console.log(`Polling for wallet ${walletId} note inclusion (attempt ${attempt})...`);
          }
        },
        timeoutErrorMessage: `Transaction for wallet ${walletId} was not included within ${INCLUSION_POLL_MAX_DURATION_MS / 1000 / 60} minutes.`,
      }
    );
    
    pollingCleanups.current.set(walletId, cleanup);
    
    promise
      .then((isIncluded) => {
        if (isIncluded) {
          console.log(`Wallet ${walletId} note successfully included!`);
        }
      })
      .catch((error) => {
        console.error(`Polling failed for wallet ${walletId}:`, error);
        stopPollingForNote(walletId);
        // Optionally show error to user
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
                    {isFunded ? (
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
                  {!isFunded && (
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

