import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider } from '@nockbox/iris-sdk';
import * as wasm from '../wasm';
import { 
  checkTransactionAcceptance,
  ACCEPTANCE_CHECK_INTERVAL_MS,
} from '../utils/tx-lifecycle';
import { useWasmCleanup, getGrpcClient, validateSignedTransaction } from '../utils/wasm-utils';

interface SeedSummary {
  recipient: string;
  amount_nicks: number;
}

interface Proposal {
  id: string;
  tx_id: string;
  lock_root_hash: string;
  proposer_pkh: string;
  status: string;
  threshold: number;
  signatures_collected: number;
  total_input_nicks: number;
  seeds: SeedSummary[];
  signers: string[];
  created_at: string;
  updated_at: string;
}

interface SignatureEntry {
  signer_pkh: string;
  signed_tx_json: string;
  signed_at: string;
}

interface ProposalDetail extends Proposal {
  raw_tx_json: string;
  notes_json: string;
  spend_conditions_json: string;
  participants: string[];
  signatures: SignatureEntry[];
}

export default function PendingProposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [broadcastingId, setBroadcastingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  
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
    if (pkh) {
      loadProposals();
    }
  }, [pkh]);

  const loadProposals = async () => {
    if (!pkh) return;
    
    try {
      setLoading(true);
      const data = await apiClient.listProposals({ pkh, status: 'pending' });
      // Also get "ready" proposals
      const readyData = await apiClient.listProposals({ pkh, status: 'ready' });
      setProposals([...data, ...readyData]);
    } catch (err: any) {
      setError(err.message || 'Failed to load proposals');
    } finally {
      setLoading(false);
    }
  };

  const handleSign = async (proposalId: string) => {
    if (!pkh) {
      setError('Wallet not connected');
      return;
    }

    try {
      setSigningId(proposalId);
      setError(null);
      setStatusMessage('Loading proposal details...');

      // Get full proposal details
      const proposal: ProposalDetail = await apiClient.getProposal(proposalId);
      
      // Reconstruct WASM objects from JSON
      setStatusMessage('Preparing transaction for signing...');
      
      const rawTxProtobuf = JSON.parse(proposal.raw_tx_json);
      const notesProtobuf = JSON.parse(proposal.notes_json);
      const spendConditionsProtobuf = JSON.parse(proposal.spend_conditions_json);
      
      // Convert back to WASM objects
      const wasmNotes = notesProtobuf.map((n: any) => 
        wasmCleanup.register(wasm.Note.fromProtobuf(n))
      );
      const wasmSpendConditions = spendConditionsProtobuf.map((sc: any) => 
        wasmCleanup.register(wasm.SpendCondition.fromProtobuf(sc))
      );
      
      // Get connected provider (reuses existing connection or establishes new one)
      setStatusMessage('Connecting to Iris wallet...');
      const provider = await getConnectedProvider();
      
      // Sign the transaction - this returns the signed tx with our signature
      setStatusMessage('Requesting signature from wallet...');
      const signedTxProtobuf = await provider.signRawTx({
        rawTx: rawTxProtobuf,
        notes: wasmNotes,
        spendConditions: wasmSpendConditions,
      });
      
      // Serialize the signed tx to JSON for storage
      const signedTxJson = JSON.stringify(signedTxProtobuf);
      
      // Submit signature with the signed tx data to backend
      setStatusMessage('Recording signature...');
      const result = await apiClient.signProposal(proposalId, pkh, signedTxJson);
      
      if (result.ready_to_broadcast) {
        setStatusMessage(`Transaction is ready to broadcast (${result.signatures_collected}/${proposal.threshold} signatures)`);
      } else {
        setStatusMessage(`Waiting for more signatures (${result.signatures_collected}/${proposal.threshold})`);
      }
      
      // Refresh proposals
      await loadProposals();
    } catch (err: any) {
      // Reset provider on failure so next attempt starts fresh
      providerRef.current = null;
      setError(err.message || 'Failed to sign proposal');
      setStatusMessage(null);
    } finally {
      setSigningId(null);
    }
  };

  const handleBroadcast = async (proposalId: string) => {
    if (!pkh || !grpcEndpoint) {
      setError('Wallet not connected');
      return;
    }

    try {
      setBroadcastingId(proposalId);
      setError(null);
      setStatusMessage('Loading proposal and signatures...');

      // Get full proposal details with all collected signatures
      console.log('[Broadcast] Loading proposal:', proposalId);
      const proposal: ProposalDetail = await apiClient.getProposal(proposalId);
      console.log('[Broadcast] Proposal loaded:', {
        threshold: proposal.threshold,
        signaturesCount: proposal.signatures.length,
        signers: proposal.signers,
      });
      
      if (proposal.signatures.length < proposal.threshold) {
        setError(`Not enough signatures: ${proposal.signatures.length}/${proposal.threshold}`);
        return;
      }
      
      setStatusMessage('Aggregating signatures...');
      
      // Get all signed tx protobufs from the collected signatures
      // IMPORTANT: Different wallet extensions compute different IDs after signing.
      // We normalize all IDs to match the FIRST signer's ID, since that transaction
      // has a valid signature for its computed ID.
      const signedTxProtobufs: any[] = [];
      let baseId: string | null = null;
      
      for (const sig of proposal.signatures) {
        console.log('[Broadcast] Parsing signature from:', sig.signer_pkh.slice(0, 12));
        const parsed = JSON.parse(sig.signed_tx_json);
        const parsedId = parsed.id?.value || parsed.id;
        
        if (baseId === null) {
          // First signer - use their ID as the base
          baseId = parsedId;
          console.log(`[Broadcast] Using base ID from first signer: ${baseId?.slice(0, 16)}...`);
        } else if (parsedId !== baseId) {
          // Subsequent signers - normalize to base ID
          console.log(`[Broadcast] Normalizing ID from ${parsedId?.slice(0, 16)}... to ${baseId?.slice(0, 16)}...`);
          if (parsed.id?.value) {
            parsed.id.value = baseId;
          } else {
            parsed.id = baseId;
          }
        }
        
        signedTxProtobufs.push(parsed);
      }
      
      console.log('[Broadcast] Merging', signedTxProtobufs.length, 'signatures with threshold', proposal.threshold);
      
      // For m-of-n multisig, we need to merge signatures from all signers.
      // Each signed tx contains one signer's signature in the witness.
      // Use mergeSignatures to combine signatures into one tx.
      // We pass the threshold to only include the minimum required signatures (minimizes fees).
      let mergedRawTx;
      try {
        mergedRawTx = wasmCleanup.register(
          wasm.RawTx.mergeSignatures(signedTxProtobufs, proposal.threshold)
        );
        console.log('[Broadcast] Signatures merged successfully');
      } catch (mergeErr: any) {
        console.error('[Broadcast] Merge failed:', mergeErr);
        throw new Error(`Failed to merge signatures: ${mergeErr?.message || mergeErr}`);
      }
      
      // CRITICAL: Recalculate the transaction ID after merging signatures.
      // The merge uses the first signer's ID, but the network computes ID from (version, spends)
      // which now has combined signatures - a different hash!
      const recalculatedId = mergedRawTx.recalcId();
      const correctTxId = recalculatedId.value;
      console.log('[Broadcast] Recalculated TX ID:', correctTxId.slice(0, 16));
      console.log('[Broadcast] Previous base ID was:', baseId?.slice(0, 16));
      
      // Get the protobuf and update the ID to the correct one
      const finalSignedTx = mergedRawTx.toProtobuf();
      const oldId = finalSignedTx.id?.value || finalSignedTx.id;
      
      // Update the ID in the protobuf to match the recalculated ID
      if (finalSignedTx.id?.value) {
        finalSignedTx.id.value = correctTxId;
      } else {
        finalSignedTx.id = correctTxId;
      }
      console.log('[Broadcast] Updated TX ID from', oldId.slice(0, 16), 'to', correctTxId.slice(0, 16));
      
      // Validate the merged transaction before broadcasting
      setStatusMessage('Validating merged transaction...');
      const notesProtobufs = JSON.parse(proposal.notes_json);
      const spendConditionsProtobufs = JSON.parse(proposal.spend_conditions_json);
      
      const validation = await validateSignedTransaction({
        signedTxProtobuf: finalSignedTx,
        notesProtobufs,
        spendConditionsProtobufs,
        cleanup: wasmCleanup,
      });
      
      if (!validation.valid) {
        console.error('[Broadcast] Validation failed:', validation.error);
        throw new Error(`Transaction validation failed: ${validation.error}`);
      }
      console.log('[Broadcast] Validation passed');
      
      // Send the transaction
      setStatusMessage('Broadcasting transaction...');
      console.log('[Broadcast] Sending to', grpcEndpoint);
      const grpcClient = await getGrpcClient(grpcEndpoint);
      
      try {
        await grpcClient.sendTransaction(finalSignedTx);
        console.log('[Broadcast] Transaction sent successfully');
      } catch (sendErr: any) {
        console.error('[Broadcast] Send failed:', sendErr);
        throw new Error(`Failed to send transaction: ${sendErr?.message || sendErr}`);
      }
      
      // Check acceptance using the recalculated ID (this should be the correct one)
      setStatusMessage('Checking acceptance...');
      console.log('[Broadcast] Checking acceptance for TX:', correctTxId.slice(0, 16));
      
      let accepted = false;
      try {
        await checkTransactionAcceptance(() => getGrpcClient(grpcEndpoint), correctTxId, {
          intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
          maxAttempts: 5,
        });
        console.log('[Broadcast] Transaction accepted!');
        accepted = true;
      } catch (e) {
        console.warn('[Broadcast] Primary ID not accepted, trying fallbacks...');
        
        // Try other possible IDs as fallback
        const fallbackIds = [baseId, proposal.tx_id].filter(
          (id): id is string => !!id && id !== correctTxId
        );
        
        for (const txId of fallbackIds) {
          console.log('[Broadcast] Trying fallback ID:', txId.slice(0, 16));
          try {
            await checkTransactionAcceptance(() => getGrpcClient(grpcEndpoint), txId, {
              intervalMs: ACCEPTANCE_CHECK_INTERVAL_MS,
              maxAttempts: 2,
            });
            console.log('[Broadcast] Transaction accepted with fallback ID:', txId.slice(0, 16));
            accepted = true;
            break;
          } catch {
            console.log('[Broadcast] Fallback ID not accepted:', txId.slice(0, 16));
          }
        }
      }
      
      if (!accepted) {
        console.warn('[Broadcast] Transaction not accepted with any known ID. Check block explorer manually.');
      }
      
      // Mark as broadcast on backend with the CORRECT tx_id (after merging signatures)
      await apiClient.markProposalBroadcast(proposalId, pkh, correctTxId);
      console.log('[Broadcast] Recorded final TX ID:', correctTxId);
      
      setStatusMessage(`Transaction broadcast! ID: ${correctTxId.substring(0, 16)}...`);
      
      // Refresh proposals
      await loadProposals();
    } catch (err: any) {
      console.error('[Broadcast] Error:', err);
      setError(err.message || 'Failed to broadcast transaction');
      setStatusMessage(null);
    } finally {
      setBroadcastingId(null);
    }
  };

  const hasAlreadySigned = (proposal: Proposal) => {
    return pkh ? proposal.signers.includes(pkh) : false;
  };

  const isReadyToBroadcast = (proposal: Proposal) => {
    return proposal.signatures_collected >= proposal.threshold || proposal.status === 'ready';
  };

  if (!pkh) {
    return null;
  }

  if (loading) {
    return (
      <div style={{ padding: '1rem', color: '#666' }}>
        Loading pending proposals...
      </div>
    );
  }

  if (proposals.length === 0) {
    return null; 
  }

  return (
    <div style={{
      marginBottom: '2rem',
      padding: '1rem',
      backgroundColor: '#fff3cd',
      borderRadius: '8px',
      border: '1px solid #ffc107',
    }}>
      <h3 style={{ margin: '0 0 1rem 0', color: '#856404' }}>
        ⏳ Pending Proposals ({proposals.length})
      </h3>
      
      {error && (
        <div style={{
          padding: '0.5rem',
          backgroundColor: '#f8d7da',
          color: '#721c24',
          borderRadius: '4px',
          marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}
      
      {statusMessage && (
        <div style={{
          padding: '0.5rem',
          backgroundColor: statusMessage.startsWith('✓') ? '#d4edda' : '#cce5ff',
          color: statusMessage.startsWith('✓') ? '#155724' : '#004085',
          borderRadius: '4px',
          marginBottom: '1rem',
          fontSize: '0.875rem',
        }}>
          {statusMessage}
        </div>
      )}
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {proposals.map(proposal => (
          <div
            key={proposal.id}
            style={{
              padding: '1rem',
              backgroundColor: 'white',
              borderRadius: '4px',
              border: '1px solid #e0e0e0',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 'bold' }}>
                  TX: {proposal.tx_id.substring(0, 16)}...
                </p>
                <p style={{ margin: '0.25rem 0', fontSize: '0.75rem', color: '#666' }}>
                  Proposed by: {proposal.proposer_pkh.substring(0, 12)}...
                </p>
                <p style={{ margin: '0.25rem 0', fontSize: '0.75rem', color: '#666' }}>
                  Input: {(proposal.total_input_nicks / 65536).toFixed(4)} NOCK
                </p>
                
                {/* Show seeds/outputs */}
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
                  <strong>Outputs:</strong>
                  {proposal.seeds.map((seed, idx) => (
                    <p key={idx} style={{ margin: '0.25rem 0 0 0.5rem', color: '#333' }}>
                      → {(seed.amount_nicks / 65536).toFixed(4)} NOCK to {seed.recipient.substring(0, 12)}...
                    </p>
                  ))}
                </div>
                
                {/* Signature status */}
                <p style={{ 
                  margin: '0.5rem 0 0', 
                  fontSize: '0.75rem',
                  color: isReadyToBroadcast(proposal) ? '#28a745' : '#856404',
                  fontWeight: 'bold',
                }}>
                  Signatures: {proposal.signatures_collected}/{proposal.threshold}
                  {hasAlreadySigned(proposal) && ' (you signed)'}
                </p>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginLeft: '1rem' }}>
                {!hasAlreadySigned(proposal) && !isReadyToBroadcast(proposal) && (
                  <button
                    onClick={() => handleSign(proposal.id)}
                    disabled={signingId === proposal.id}
                    style={{
                      padding: '0.5rem 1rem',
                      backgroundColor: signingId === proposal.id ? '#ccc' : '#28a745',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: signingId === proposal.id ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                    }}
                  >
                    {signingId === proposal.id ? 'Signing...' : 'Sign'}
                  </button>
                )}
                
                {isReadyToBroadcast(proposal) && (
                  <button
                    onClick={() => handleBroadcast(proposal.id)}
                    disabled={broadcastingId === proposal.id}
                    style={{
                      padding: '0.5rem 1rem',
                      backgroundColor: broadcastingId === proposal.id ? '#ccc' : '#007bff',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: broadcastingId === proposal.id ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                    }}
                  >
                    {broadcastingId === proposal.id ? 'Broadcasting...' : 'Broadcast'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      
      <button
        onClick={loadProposals}
        style={{
          marginTop: '1rem',
          padding: '0.5rem 1rem',
          backgroundColor: 'transparent',
          border: '1px solid #856404',
          color: '#856404',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '0.875rem',
        }}
      >
        ↻ Refresh
      </button>
    </div>
  );
}

