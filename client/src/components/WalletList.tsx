import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider } from '@nockbox/iris-sdk';
import * as wasm from '../wasm';
import { 
  checkTransactionAcceptance, 
  pollForTransactionInclusionWithCleanup,
  ACCEPTANCE_CHECK_INTERVAL_MS,
  ACCEPTANCE_CHECK_MAX_ATTEMPTS,
  INCLUSION_POLL_INTERVAL_MS,
  INCLUSION_POLL_MAX_DURATION_MS
} from '../utils/tx-lifecycle';
import { useWasmCleanup, getGrpcClient } from '../utils/wasm-cleanup';
import TransactionProposal from './TransactionProposal';
import PendingProposals from './PendingProposals';
import TransactionHistory from './TransactionHistory';

/**
 * Represents a single note (UTXO) associated with a multisig wallet.
 */
export interface WalletNote {
  /** Raw protobuf object from gRPC - pass to wasm.Note.fromProtobuf() */
  protoNote: any;
  /** Note amount in nicks*/
  assets: number;
  /** Lock root hash (first name) - same for all notes in this wallet */
  firstName: string;
  /** Source hash (second/last name) - unique per note, identifies origin */
  sourceHash: string;
  /** Full note name as "firstName:sourceHash" for display */
  displayName: string;
}

interface WalletWithStatus {
  lock_root_hash: string;
  threshold: number;
  total_signers: number;
  created_at: string;
  created_by_pkh: string;
  participants: string[];  // PKHs that can sign for this wallet
  balance?: number;
  isPolling?: boolean;
  /**
   * Store notes for transaction building (only when funded)
   * 
   * To propose a transaction from this multisig wallet:
   * 1. Get notes: wallet.notes (array of WalletNote)
   * 2. Select which notes to spend (user picks from UI)
   * 3. Create WASM Note objects: selectedNotes.map(n => wasm.Note.fromProtobuf(n.protoNote))
   * 4. Reconstruct multisig SpendCondition from participants/threshold
   * 5. Build transaction with selected notes, creating seeds for outputs
   * 
   * Each note has:
   * - protoNote: raw protobuf for WASM
   * - assets: amount in nicks
   * - firstName: lock root hash (same for all notes in wallet)
   * - sourceHash: unique source commitment (distinguishes notes)
   */
  notes?: WalletNote[];
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
          balance: undefined,
          notes: undefined, // Unknown until we check
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
          
          let totalBalance = 0;
          const notes: WalletNote[] = [];
          
          if (balance?.notes) {
            for (const n of balance.notes) {
              // Extract assets from the note (handle both V1 and legacy formats)
              // Note: u64 values are serialized as strings by serde
              const assetsValue = 
                n.note?.note_version?.V1?.assets?.value ||
                n.note?.note_version?.Legacy?.assets?.value ||
                '0';
              const assets = Number(assetsValue);
              totalBalance += assets;
              
              // Extract note name (first = lock root, last = source hash)
              // The name uniquely identifies this note on the blockchain
              const firstName = n.name?.first || wallet.lock_root_hash;
              const sourceHash = n.name?.last || '';
              
              notes.push({ 
                protoNote: n.note, 
                assets,
                firstName,
                sourceHash,
                displayName: sourceHash ? `${firstName.slice(0, 8)}...${sourceHash.slice(0, 8)}` : firstName.slice(0, 16),
              });
            }
          }
          
          if (isMountedRef.current) {
            setWallets(prev => prev.map(w => 
              w.lock_root_hash === wallet.lock_root_hash 
                ? { ...w, balance: totalBalance, notes: notes.length > 0 ? notes : [] }
                : w
            ));
          }
        } catch (e: any) {
          console.error(`Failed to fetch balance for wallet ${wallet.lock_root_hash}:`, e);
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
      setFunding(new Set([...funding, wallet.lock_root_hash]));
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
      const amountNock = fundingAmounts.get(wallet.lock_root_hash) || 1;
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

      startPollingForNote(wallet.lock_root_hash);
    } catch (err: any) {
      setError(err.message || 'Failed to fund wallet');
      console.error('Fund wallet error:', err);
    } finally {
      setFunding(new Set([...funding].filter(id => id !== wallet.lock_root_hash)));
    }
  };

  const startPollingForNote = (lockRootHash: string) => {
    stopPollingForNote(lockRootHash);
    
    if (!grpcEndpoint) {
      setError('gRPC endpoint not available');
      return;
    }
    
    setPollingWallets(prev => new Set([...prev, lockRootHash]));
    
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
          stopPollingForNote(lockRootHash);
        },
        onPoll: () => {},
        timeoutErrorMessage: `Transaction for wallet ${lockRootHash} was not included within ${INCLUSION_POLL_MAX_DURATION_MS / 1000 / 60} minutes.`,
      }
    );
    
    pollingCleanups.current.set(lockRootHash, cleanup);
    
    promise
      .then((isIncluded) => {
        if (!isMountedRef.current) return;
        if (isIncluded) stopPollingForNote(lockRootHash);
      })
      .catch((error) => {
        if (!isMountedRef.current) return;
        console.error(`Polling failed for wallet ${lockRootHash}:`, error);
        stopPollingForNote(lockRootHash);
        setError(`Failed to confirm transaction inclusion: ${error.message}`);
      });
  };

  const stopPollingForNote = (lockRootHash: string) => {
    const cleanup = pollingCleanups.current.get(lockRootHash);
    if (cleanup) {
      cleanup();
      pollingCleanups.current.delete(lockRootHash);
    }
    setPollingWallets(prev => {
      const next = new Set(prev);
      next.delete(lockRootHash);
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
      
      {/* Pending proposals that need signatures */}
      <PendingProposals />
      
      {wallets.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
          <p>No wallets found. Create your first multisig wallet to get started.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {wallets.map((wallet) => {
            const isFunding = funding.has(wallet.lock_root_hash);
            const isLoadingBalance = wallet.notes === undefined;
            const isFunded = wallet.notes && wallet.notes.length > 0;
            const balance = wallet.balance || 0;
            const balanceNock = balance / 65536;

            return (
              <div
                key={wallet.lock_root_hash}
                style={{
                  padding: '1.5rem',
                  backgroundColor: 'white',
                  borderRadius: '8px',
                  border: `2px solid ${isFunded ? '#28a745' : '#e0e0e0'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ margin: 0 }}>{`Wallet ${wallet.lock_root_hash.substring(0, 8)}`}</h3>
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
                      <div style={{ marginTop: '0.5rem' }}>
                        <p style={{ 
                          color: '#28a745', 
                          fontSize: '0.875rem', 
                          fontWeight: 'bold',
                          margin: 0,
                        }}>
                          ✓ Funded: {balanceNock.toFixed(4)} NOCK
                          {wallet.notes && wallet.notes.length > 1 && (
                            <span style={{ fontWeight: 'normal', color: '#666', marginLeft: '0.5rem' }}>
                              ({wallet.notes.length} notes)
                            </span>
                          )}
                        </p>
                        {/* Show individual notes when there are multiple */}
                        {wallet.notes && wallet.notes.length > 1 && (
                          <div style={{ 
                            marginTop: '0.5rem', 
                            paddingLeft: '1rem',
                            borderLeft: '2px solid #e0e0e0',
                          }}>
                            {wallet.notes.map((note, idx) => (
                              <p key={note.sourceHash || idx} style={{ 
                                fontSize: '0.75rem', 
                                color: '#666',
                                margin: '0.25rem 0',
                                fontFamily: 'monospace',
                              }}>
                                Note {idx + 1}: {(note.assets / 65536).toFixed(4)} NOCK
                                <span style={{ color: '#999', marginLeft: '0.5rem' }}>
                                  ({note.sourceHash ? note.sourceHash.slice(0, 12) + '...' : 'pending'})
                                </span>
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
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
                    {pollingWallets.has(wallet.lock_root_hash) && (
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
                        value={fundingAmounts.get(wallet.lock_root_hash) || 1}
                        onChange={(e) => {
                          const amount = parseFloat(e.target.value) || 1;
                          setFundingAmounts(prev => new Map(prev).set(wallet.lock_root_hash, amount));
                        }}
                        placeholder="Amount (NOCK)"
                        style={{
                          padding: '0.5rem',
                          border: '1px solid #ddd',
                          borderRadius: '4px',
                          width: '120px',
                        }}
                        disabled={isFunding || pollingWallets.has(wallet.lock_root_hash)}
                      />
                      <button
                        onClick={() => handleFundWallet(wallet)}
                        disabled={isFunding || pollingWallets.has(wallet.lock_root_hash)}
                        style={{
                          padding: '0.5rem 1rem',
                          backgroundColor: (isFunding || pollingWallets.has(wallet.lock_root_hash)) ? '#ccc' : '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: (isFunding || pollingWallets.has(wallet.lock_root_hash)) ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isFunding ? 'Funding...' : pollingWallets.has(wallet.lock_root_hash) ? 'Waiting...' : 'Initialize Note'}
                      </button>
                    </div>
                  )}
                </div>
                
                {/* Transaction Proposal for funded wallets */}
                {isFunded && wallet.notes && (
                  <TransactionProposal
                    lockRootHash={wallet.lock_root_hash}
                    threshold={wallet.threshold}
                    participants={wallet.participants}
                    notes={wallet.notes}
                    onTransactionSent={loadWallets}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      
      {/* Transaction history ledger */}
      <TransactionHistory />
    </div>
  );
}

