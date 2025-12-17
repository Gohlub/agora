import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider } from '@nockbox/iris-sdk';
import { 
  getGrpcClient, 
  useWasmCleanup, 
  buildMultisigSpendCondition,
  buildUnsignedMultisigFundingTx,
  ensureWasmInitialized 
} from '../utils/wasm-utils';
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
  const [error, setError] = useState<string | null>(null);
  const [funding, setFunding] = useState<Set<string>>(new Set());
  const [fundingAmounts, setFundingAmounts] = useState<Map<string, string>>(new Map());
  const [fundingStatus, setFundingStatus] = useState<string | null>(null);
  const { pkh, grpcEndpoint } = useWalletStore();
  const isMountedRef = useRef(true);
  const wasmCleanup = useWasmCleanup();
  
  // Persistent provider instance - reuse across operations
  const providerRef = useRef<NockchainProvider | null>(null);
  
  /**
   * Get or create the Iris provider, ensuring it's connected
   */
  const getConnectedProvider = async (): Promise<NockchainProvider> => {
    // Create provider if it doesn't exist
    if (!providerRef.current) {
      providerRef.current = new NockchainProvider();
    }
    
    const provider = providerRef.current;
    
    // Check if already connected
    if (provider.isConnected) {
      return provider;
    }
    
    // Not connected - establish connection
    try {
      await provider.connect();
      
      // Give the extension a moment to fully initialize after connection
      // This prevents race conditions where signRawTx is called too quickly
      await new Promise(resolve => setTimeout(resolve, 500));
      
      return provider;
    } catch (connectErr: any) {
      // Reset provider on connection failure so next attempt starts fresh
      providerRef.current = null;
      throw new Error(
        `Failed to connect to Iris wallet: ${connectErr?.message || 'Unknown error'}. ` +
        `Make sure the Iris extension is installed and unlocked.`
      );
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    
    if (pkh && grpcEndpoint) {
      loadWallets();
    }
    
    return () => {
      isMountedRef.current = false;
    };
  }, [pkh, grpcEndpoint]);

  /**
   * Fund a multisig wallet by creating a transaction that sends funds to the multisig spend condition.
   */
  const handleFundWallet = async (wallet: WalletWithStatus) => {
    if (!pkh || !grpcEndpoint) {
      setError('Wallet not connected');
      return;
    }

    const lockRootHash = wallet.lock_root_hash;
    
    try {
      setFunding(prev => new Set([...prev, lockRootHash]));
      setError(null);
      setFundingStatus('Initializing...');

      await ensureWasmInitialized();

      // Get funding amount (default: 1 NOCK = 65536 nicks)
      const amountNock = parseFloat(fundingAmounts.get(lockRootHash) || '1') || 1;
      const amountNicks = Math.floor(amountNock * 65536);

      // Build the multisig spend condition
      setFundingStatus('Preparing multisig lock...');
      const multisigSpendCondition = await buildMultisigSpendCondition(
        wallet.threshold,
        wallet.participants,
        wasmCleanup
      );

      // Build the unsigned transaction using the utility function
      setFundingStatus('Building transaction...');
      const unsignedTx = await buildUnsignedMultisigFundingTx({
        userPkh: pkh,
        grpcEndpoint,
        amountNicks,
        multisigSpendCondition,
        cleanup: wasmCleanup,
      });

      // Get connected provider (reuses existing connection or establishes new one)
      setFundingStatus('Connecting to Iris wallet...');
      const provider = await getConnectedProvider();
      
      setFundingStatus('Requesting signature... (check Iris wallet popup)');
      
      const signedTxBytes = await provider.signRawTx({
        rawTx: unsignedTx.rawTxProtobuf,
        notes: unsignedTx.notesProtobufs,
        spendConditions: unsignedTx.spendConditionsProtobufs,
      });
      
      // Extract the transaction ID from the signed transaction
      const idField = (signedTxBytes as any).id;
      const signedTxId = typeof idField === 'string' ? idField : idField?.value;
      
      // Broadcast the transaction
      setFundingStatus('Broadcasting transaction...');
      const grpcClient = await getGrpcClient(grpcEndpoint);
      await grpcClient.sendTransaction(signedTxBytes);

      // Check acceptance
      setFundingStatus('Confirming transaction...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      let accepted = false;
      for (let i = 0; i < 3; i++) {
        accepted = await grpcClient.transactionAccepted(signedTxId);
        if (accepted) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (accepted) {
        setFundingStatus(`Transaction confirmed! ID: ${signedTxId.substring(0, 16)}...`);
      } else {
        setFundingStatus(`Transaction broadcast! ID: ${signedTxId.substring(0, 16)}... (confirming...)`);
      }
      

    } catch (err: any) {
      providerRef.current = null;
      setError('Signing failed/cancelled');
      setFundingStatus(null);
    } finally {
      setFunding(prev => {
        const next = new Set(prev);
        next.delete(lockRootHash);
        return next;
      });
    }
  };

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

   if (loading) {
    return <div>Loading wallets...</div>;
  }

  return (
    <div>
      {/* Inline error notification - dismissible */}
      {error && (
        <div style={{ 
          padding: '0.75rem 1rem', 
          backgroundColor: '#fee', 
          color: '#c33', 
          borderRadius: '4px',
          marginBottom: '1rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span>{error}</span>
          <button 
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#c33',
              cursor: 'pointer',
              fontSize: '1.2rem',
              padding: '0 0.5rem'
            }}
          >
            ×
          </button>
        </div>
      )}
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Wallets</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => loadWallets()}
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            ↻ Refresh
          </button>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <h3 style={{ margin: 0 }}>{`Wallet ${wallet.lock_root_hash.substring(0, 8)}...`}</h3>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(wallet.lock_root_hash);
                          // Brief visual feedback
                          const btn = document.getElementById(`copy-${wallet.lock_root_hash}`);
                          if (btn) {
                            btn.textContent = '✓ Copied!';
                            setTimeout(() => { btn.textContent = 'Copy Address'; }, 1500);
                          }
                        }}
                        id={`copy-${wallet.lock_root_hash}`}
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.75rem',
                          backgroundColor: '#f0f0f0',
                          border: '1px solid #ccc',
                          borderRadius: '4px',
                          cursor: 'pointer',
                        }}
                      >
                        Copy Address
                      </button>
                    </div>
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
                  </div>
                  {!isLoadingBalance && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginLeft: '1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="1"
                          value={fundingAmounts.get(wallet.lock_root_hash) || ''}
                          onChange={(e) => {
                            const value = e.target.value;
                            if (value === '' || /^\d*\.?\d*$/.test(value)) {
                              setFundingAmounts(prev => new Map(prev).set(wallet.lock_root_hash, value));
                            }
                          }}
                          style={{
                            padding: '0.25rem 0.5rem',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            width: '60px',
                            textAlign: 'left',
                          }}
                          disabled={funding.has(wallet.lock_root_hash)}
                        />
                        <span style={{ color: '#666', fontSize: '0.875rem' }}>NOCK</span>
                      </div>
                      <button
                        onClick={() => handleFundWallet(wallet)}
                        disabled={funding.has(wallet.lock_root_hash)}
                        style={{
                          padding: '0.5rem 1rem',
                          backgroundColor: funding.has(wallet.lock_root_hash) ? '#ccc' : '#28a745',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: funding.has(wallet.lock_root_hash) ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {funding.has(wallet.lock_root_hash) ? 'Funding...' : 'Fund Wallet'}
                      </button>
                      {fundingStatus && funding.has(wallet.lock_root_hash) && (
                        <p style={{ margin: 0, fontSize: '0.75rem', color: '#007bff' }}>
                          {fundingStatus}
                        </p>
                      )}
                      <p style={{ 
                        margin: 0, 
                        fontSize: '0.7rem', 
                        color: '#999',
                        lineHeight: '1.3'
                      }}>
                      </p>
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

