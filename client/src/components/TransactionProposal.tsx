import { useState, useRef } from 'react';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider } from '@nockbox/iris-sdk';
import { 
  useWasmCleanup, 
  getGrpcClient, 
  buildUnsignedMultisigSpendTx,
  validateSignedTransaction,
  type MultisigNoteInput,
  type TransactionSeed,
} from '../utils/wasm-utils';
import { 
  checkTransactionAcceptance,
  ACCEPTANCE_CHECK_INTERVAL_MS,
  ACCEPTANCE_CHECK_MAX_ATTEMPTS,
} from '../utils/tx-lifecycle';
import type { WalletNote } from './WalletList';

type DestinationType = 'wallet' | 'lockroot';

interface Seed {
  id: string;
  destinationType: DestinationType;
  destination: string; // wallet address or lock root hash
  amountNock: number;
}

interface TransactionProposalProps {
  lockRootHash: string;
  threshold: number;
  participants: string[];
  notes: WalletNote[];
  onTransactionSent?: () => void;
}

export default function TransactionProposal({
  lockRootHash,
  threshold,
  participants,
  notes,
  onTransactionSent,
}: TransactionProposalProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const [seeds, setSeeds] = useState<Seed[]>([{ id: '1', destinationType: 'wallet', destination: '', amountNock: 0 }]);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [actualFee, setActualFee] = useState<number | null>(null); // Actual fee from built transaction
  
  const { pkh, grpcEndpoint } = useWalletStore();
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

  // Calculate totals
  const selectedTotal = notes
    .filter(n => selectedNotes.has(n.sourceHash))
    .reduce((sum, n) => sum + n.assets, 0);
  const selectedTotalNock = selectedTotal / 65536;
  
  const seedsTotal = seeds.reduce((sum, s) => sum + (s.amountNock || 0), 0);
  
  // Only show fee after transaction is built (actual fee from TxBuilder)
  // Before building, we don't show a fee estimate since it may be inaccurate
  const remaining = selectedTotalNock - seedsTotal - (actualFee ?? 0);

  const toggleNote = (sourceHash: string) => {
    setSelectedNotes(prev => {
      const next = new Set(prev);
      if (next.has(sourceHash)) {
        next.delete(sourceHash);
      } else {
        next.add(sourceHash);
      }
      return next;
    });
    setActualFee(null); // Reset actual fee when note selection changes
  };

  const selectAllNotes = () => {
    setSelectedNotes(new Set(notes.map(n => n.sourceHash)));
  };

  const deselectAllNotes = () => {
    setSelectedNotes(new Set());
  };

  const addSeed = () => {
    setSeeds([...seeds, { 
      id: String(Date.now()), 
      destinationType: 'wallet',
      destination: '', 
      amountNock: 0 
    }]);
  };

  const updateSeed = (id: string, field: 'destinationType' | 'destination' | 'amountNock', value: string | number) => {
    setSeeds(prev => prev.map(s => 
      s.id === id ? { ...s, [field]: value } : s
    ));
    setActualFee(null); // Reset actual fee when seeds change
  };

  const removeSeed = (id: string) => {
    if (seeds.length > 1) {
      setSeeds(prev => prev.filter(s => s.id !== id));
    }
  };

  const handleConsolidate = () => {
    // Select all notes, consolidate back to this multisig's lock root
    // Leave amount at 0 - user should build to see actual fee, then adjust
    selectAllNotes();
    setSeeds([{ 
      id: '1', 
      destinationType: 'lockroot',
      destination: lockRootHash, 
      amountNock: 0 // User adjusts after seeing actual fee
    }]);
  };

  const handleBuildTransaction = async () => {
    if (!pkh) {
      setError('Wallet not connected');
      return;
    }

    if (selectedNotes.size === 0) {
      setError('Please select at least one note to spend');
      return;
    }

    const validSeeds = seeds.filter(s => s.destination.trim() && s.amountNock > 0);
    if (validSeeds.length === 0) {
      setError('Please add at least one recipient with a valid amount');
      return;
    }

    if (participants.length === 0) {
      setError('Multisig participants not available');
      return;
    }

    // Verify the connected wallet is a participant in this multisig
    if (!participants.includes(pkh)) {
      setError(`Your wallet (${pkh.substring(0, 12)}...) is not a participant in this multisig. ` +
        `Participants: ${participants.map(p => p.substring(0, 12) + '...').join(', ')}`);
      return;
    }

    try {
      setBuilding(true);
      setError(null);
      setTxStatus('Building transaction...');

      // Prepare note inputs for the utility function
      const selectedNotesList = notes.filter(n => selectedNotes.has(n.sourceHash));
      const noteInputs: MultisigNoteInput[] = selectedNotesList.map(n => ({
        protoNote: n.protoNote,
        assets: n.assets,
        nameFirst: n.firstName, // Include for spend condition verification
      }));

      // Prepare seeds for the utility function
      const txSeeds: TransactionSeed[] = validSeeds.map(s => ({
        destinationType: s.destinationType,
        destination: s.destination,
        amountNock: s.amountNock,
      }));

      // Build the unsigned transaction using the utility function
      // This properly handles WASM object ownership
      const unsignedTx = await buildUnsignedMultisigSpendTx({
        threshold,
        participants,
        selectedNotes: noteInputs,
        seeds: txSeeds,
        cleanup: wasmCleanup,
      });

      const { txId, rawTxProtobuf, notesProtobufs, spendConditionsProtobufs, actualFeeNock } = unsignedTx;
      
      // Update UI with actual fee
      setActualFee(actualFeeNock);

      // Serialize transaction data for backend storage
      const rawTxJson = JSON.stringify(rawTxProtobuf);
      const notesJson = JSON.stringify(notesProtobufs);
      const spendConditionsJson = JSON.stringify(spendConditionsProtobufs);

      // Sign the transaction
      setTxStatus('Connecting to Iris wallet...');
      const provider = await getConnectedProvider();
      
      setTxStatus('Requesting signature... (check Iris wallet popup)');
      const signedTxProtobuf = await provider.signRawTx({
        rawTx: rawTxProtobuf,
        notes: notesProtobufs,
        spendConditions: spendConditionsProtobufs,
      });

      // Format seeds for API (stores destination type in recipient field for now)
      const seedsSummary = validSeeds.map(s => ({
        recipient: `${s.destinationType}:${s.destination}`,
        amount_nicks: Math.floor(s.amountNock * 65536),
      }));

      if (threshold === 1) {
        // Direct spend: sign → validate → broadcast → record history
        if (!grpcEndpoint) {
          throw new Error('gRPC endpoint not configured');
        }

        // Validate the signed transaction before broadcasting
        setTxStatus('Validating signed transaction...');
        const validation = await validateSignedTransaction({
          signedTxProtobuf,
          notesProtobufs,
          spendConditionsProtobufs,
          cleanup: wasmCleanup,
        });
        
        if (!validation.valid) {
          throw new Error(`Transaction validation failed: ${validation.error}`);
        }

        // The wallet extension returns a transaction with the signed ID
        const actualTxId = validation.signedTxId || txId;

        setTxStatus('Broadcasting transaction...');
        const grpcClient = await getGrpcClient(grpcEndpoint);
        
        try {
          await grpcClient.sendTransaction(signedTxProtobuf);
        } catch (sendErr: any) {
          throw new Error(`Failed to send transaction: ${sendErr?.message || sendErr}`);
        }

        setTxStatus('Confirming acceptance...');
        
        // Try both possible transaction IDs
        try {
          await checkTransactionAcceptance(() => getGrpcClient(grpcEndpoint), actualTxId, {
            intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
            maxAttempts: 5,
          });
        } catch (e1) {
          // Try the original ID as fallback
          try {
            await checkTransactionAcceptance(() => getGrpcClient(grpcEndpoint), txId, {
              intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
              maxAttempts: ACCEPTANCE_CHECK_MAX_ATTEMPTS,
            });
          } catch (e2) {
            throw new Error(
              'Transaction was not accepted. The note may have already been spent. ' +
              'Please refresh the wallet and try again.'
            );
          }
        }

        setTxStatus('Recording transaction...');
        await apiClient.directSpend({
          tx_id: actualTxId,
          lock_root_hash: lockRootHash,
          sender_pkh: pkh,
          total_input_nicks: selectedTotal,
          seeds: seedsSummary,
        });

        setTxStatus(`Transaction sent! ID: ${actualTxId.substring(0, 16)}...`);
      } else {
        // Proposal flow: create proposal with signature for m-of-n
        const proposerSignedTxJson = JSON.stringify(signedTxProtobuf);

        setTxStatus('Submitting proposal...');
        const proposal = await apiClient.createProposal({
          tx_id: txId,
          lock_root_hash: lockRootHash,
          proposer_pkh: pkh,
          threshold,
          raw_tx_json: rawTxJson,
          notes_json: notesJson,
          spend_conditions_json: spendConditionsJson,
          total_input_nicks: selectedTotal,
          seeds: seedsSummary,
          proposer_signed_tx_json: proposerSignedTxJson,
        });

        const signaturesNeeded = threshold - 1;
        setTxStatus(`Proposal created & signed! ID: ${proposal.id.substring(0, 8)}... Awaiting ${signaturesNeeded} more signature(s).`);
      }
      
      // Reset form
      setSelectedNotes(new Set());
      setSeeds([{ id: '1', destinationType: 'wallet', destination: '', amountNock: 0 }]);
      
      // Notify parent to refresh (so pending proposals can be shown)
      onTransactionSent?.();
    } catch (err: any) {
      // Reset provider on failure so next attempt starts fresh
      providerRef.current = null;
      setError(err.message || 'Failed to create proposal');
      setTxStatus(null);
    } finally {
      setBuilding(false);
    }
  };

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        style={{
          marginTop: '1rem',
          padding: '0.5rem 1rem',
          backgroundColor: '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          width: '100%',
        }}
      >
        {threshold === 1 ? 'Send Transaction' : 'Propose Transaction'}
      </button>
    );
  }

  const isDirectSpend = threshold === 1;

  return (
    <div style={{
      marginTop: '1rem',
      padding: '1rem',
      backgroundColor: '#f8f9fa',
      borderRadius: '8px',
      border: '1px solid #dee2e6',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h4 style={{ margin: 0 }}>{isDirectSpend ? 'Send Transaction' : 'Propose Transaction'}</h4>
        <button
          onClick={() => setIsExpanded(false)}
          style={{
            padding: '0.25rem 0.5rem',
            backgroundColor: 'transparent',
            border: '1px solid #ccc',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {error && (
        <div style={{
          padding: '0.5rem',
          backgroundColor: '#fee',
          color: '#c33',
          borderRadius: '4px',
          marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}

      {txStatus && (
        <div style={{
          padding: '0.5rem',
          backgroundColor: txStatus.startsWith('✓') ? '#d4edda' : '#cce5ff',
          color: txStatus.startsWith('✓') ? '#155724' : '#004085',
          borderRadius: '4px',
          marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          {txStatus}
        </div>
      )}

      {/* Note Selection */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <label style={{ fontWeight: 'bold', fontSize: '0.875rem' }}>
                Select Notes to Spend
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={selectAllNotes}
                  style={{
                    padding: '0.25rem 0.5rem',
                    fontSize: '0.75rem',
                    backgroundColor: '#e9ecef',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Select All
                </button>
                <button
                  onClick={deselectAllNotes}
                  style={{
                    padding: '0.25rem 0.5rem',
                    fontSize: '0.75rem',
                    backgroundColor: '#e9ecef',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
            <div style={{ 
              maxHeight: '150px', 
              overflowY: 'auto',
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              backgroundColor: 'white',
            }}>
              {notes.map((note, idx) => (
                <label
                  key={note.sourceHash || idx}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.5rem',
                    borderBottom: idx < notes.length - 1 ? '1px solid #eee' : 'none',
                    cursor: 'pointer',
                    backgroundColor: selectedNotes.has(note.sourceHash) ? '#e7f3ff' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedNotes.has(note.sourceHash)}
                    onChange={() => toggleNote(note.sourceHash)}
                    style={{ marginRight: '0.5rem' }}
                  />
                  <span style={{ flex: 1, fontSize: '0.875rem' }}>
                    {(note.assets / 65536).toFixed(4)} NOCK
                  </span>
                  <span style={{ fontSize: '0.75rem', color: '#666', fontFamily: 'monospace' }}>
                    {note.sourceHash ? note.sourceHash.slice(0, 12) + '...' : `Note ${idx + 1}`}
                  </span>
                </label>
              ))}
            </div>
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#666' }}>
              Selected: {selectedTotalNock.toFixed(4)} NOCK ({selectedNotes.size} notes)
            </p>
          </div>

          {/* Recipients (Seeds) */}
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <label style={{ fontWeight: 'bold', fontSize: '0.875rem' }}>
                Send To
              </label>
              <button
                onClick={handleConsolidate}
                style={{
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.75rem',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
                title="Consolidate all notes into one"
              >
                Consolidate Notes
              </button>
            </div>
            
            {seeds.map((seed) => (
              <div key={seed.id} style={{ 
                marginBottom: '0.75rem',
                padding: '0.5rem',
                backgroundColor: '#f8f9fa',
                borderRadius: '4px',
                border: '1px solid #dee2e6',
              }}>
                {/* Destination Type Toggle */}
                <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={() => updateSeed(seed.id, 'destinationType', 'wallet')}
                    style={{
                      flex: 1,
                      padding: '0.3rem 0.5rem',
                      fontSize: '0.75rem',
                      backgroundColor: seed.destinationType === 'wallet' ? '#007bff' : '#e9ecef',
                      color: seed.destinationType === 'wallet' ? 'white' : '#333',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                    }}
                  >
                    Wallet Address
                  </button>
                  <button
                    onClick={() => updateSeed(seed.id, 'destinationType', 'lockroot')}
                    style={{
                      flex: 1,
                      padding: '0.3rem 0.5rem',
                      fontSize: '0.75rem',
                      backgroundColor: seed.destinationType === 'lockroot' ? '#007bff' : '#e9ecef',
                      color: seed.destinationType === 'lockroot' ? 'white' : '#333',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                    }}
                  >
                    Lock Root
                  </button>
                </div>
                
                {/* Destination Input */}
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={seed.destination}
                    onChange={(e) => updateSeed(seed.id, 'destination', e.target.value)}
                    placeholder={seed.destinationType === 'wallet' ? 'Wallet address (PKH)' : 'Lock root hash'}
                    style={{
                      flex: 2,
                      padding: '0.5rem',
                      border: '1px solid #ced4da',
                      borderRadius: '4px',
                      fontSize: '0.875rem',
                    }}
                  />
                  <input
                    type="number"
                    value={seed.amountNock || ''}
                    onChange={(e) => updateSeed(seed.id, 'amountNock', parseFloat(e.target.value) || 0)}
                    placeholder="NOCK"
                    min="0"
                    step="0.0001"
                    style={{
                      width: '90px',
                      padding: '0.5rem',
                      border: '1px solid #ced4da',
                      borderRadius: '4px',
                      fontSize: '0.875rem',
                    }}
                  />
                  {seeds.length > 1 && (
                    <button
                      onClick={() => removeSeed(seed.id)}
                      style={{
                        padding: '0.5rem',
                        backgroundColor: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
            
            <button
              onClick={addSeed}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              + Add Recipient
            </button>
          </div>

          {/* Summary */}
          <div style={{
            padding: '0.75rem',
            backgroundColor: '#e9ecef',
            borderRadius: '4px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
          }}>
            <div style={{ marginBottom: '0.5rem', fontWeight: 'bold', color: '#495057' }}>
              Transaction Summary
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Spending from this wallet:</span>
              <span>{selectedTotalNock.toFixed(4)} NOCK</span>
            </div>
            
            {/* Show each recipient */}
            {seeds.filter(s => s.amountNock > 0 && s.destination.trim()).map((seed) => {
              const typeLabel = seed.destinationType === 'wallet' ? 'wallet' : 'lock root';
              const displayAddr = seed.destination.slice(0, 10) + '...';
              return (
                <div key={seed.id} style={{ display: 'flex', justifyContent: 'space-between', color: '#28a745', fontSize: '0.8rem' }}>
                  <span>→ {displayAddr} ({typeLabel})</span>
                  <span>{seed.amountNock.toFixed(4)} NOCK</span>
                </div>
              );
            })}
            
            <div style={{ display: 'flex', justifyContent: 'space-between', color: actualFee ? '#28a745' : '#6c757d' }}>
              <span>→ Network fee:</span>
              <span>{actualFee ? `${actualFee.toFixed(4)} NOCK` : '(calculated on build)'}</span>
            </div>
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between',
              color: '#17a2b8',
            }}>
              <span>→ Remaining in wallet:</span>
              <span>{Math.max(0, remaining).toFixed(4)} NOCK</span>
            </div>
            {remaining < 0 && (
              <div style={{ 
                marginTop: '0.5rem',
                padding: '0.25rem 0.5rem',
                backgroundColor: '#f8d7da',
                color: '#721c24',
                borderRadius: '4px',
                fontSize: '0.75rem',
              }}>
                Not enough funds! Need {Math.abs(remaining).toFixed(4)} more NOCK
              </div>
            )}
          </div>

          {/* Build Button */}
          <button
            onClick={handleBuildTransaction}
            disabled={building || selectedNotes.size === 0 || remaining < 0}
            style={{
              width: '100%',
              padding: '0.75rem',
              backgroundColor: (building || selectedNotes.size === 0 || remaining < 0) ? '#ccc' : '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: (building || selectedNotes.size === 0 || remaining < 0) ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 'bold',
            }}
          >
            {building ? (isDirectSpend ? 'Sending...' : 'Creating...') : (isDirectSpend ? 'Send' : 'Create Proposal')}
          </button>
          
          {remaining < 0 && (
            <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#dc3545', textAlign: 'center' }}>
              Outputs exceed available balance (including fees)
            </p>
          )}
    </div>
  );
}

