import { useState, useEffect } from 'react';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';

interface SeedSummary {
  recipient: string;
  amount_nicks: number;
}

interface HistoryEntry {
  id: string;
  tx_id: string;
  lock_root_hash: string;
  proposer_pkh: string;
  status: string;
  total_input_nicks: number;
  seeds: SeedSummary[];
  signers: string[];
  created_at: string;
  broadcast_at: string | null;
  confirmed_at: string | null;
}

export default function TransactionHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  
  const { pkh } = useWalletStore();

  useEffect(() => {
    if (pkh) {
      loadHistory();
    }
  }, [pkh]);

  const loadHistory = async () => {
    if (!pkh) return;
    
    try {
      setLoading(true);
      const data = await apiClient.getTransactionHistory({ pkh });
      setHistory(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load transaction history');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed': return '#28a745';
      case 'broadcast': return '#007bff';
      case 'failed': return '#dc3545';
      default: return '#666';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'confirmed': return '✓';
      case 'broadcast': return '📡';
      case 'failed': return '✗';
      default: return '?';
    }
  };

  if (!pkh) {
    return null;
  }

  if (loading) {
    return (
      <div style={{ padding: '1rem', color: '#666' }}>
        Loading transaction history...
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div style={{
        marginTop: '2rem',
        padding: '1.5rem',
        backgroundColor: '#f8f9fa',
        borderRadius: '8px',
        textAlign: 'center',
        color: '#666',
      }}>
        <h3 style={{ margin: '0 0 0.5rem 0' }}>Transaction History</h3>
        <p style={{ margin: 0 }}>No transactions yet.</p>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: '2rem',
      padding: '1.5rem',
      backgroundColor: '#f8f9fa',
      borderRadius: '8px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Transaction History</h3>
        <button
          onClick={loadHistory}
          style={{
            padding: '0.25rem 0.5rem',
            backgroundColor: 'transparent',
            border: '1px solid #ccc',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          ↻ Refresh
        </button>
      </div>
      
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
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {history.map(entry => (
          <div
            key={entry.id}
            style={{
              backgroundColor: 'white',
              borderRadius: '4px',
              border: '1px solid #e0e0e0',
              overflow: 'hidden',
            }}
          >
            {/* Header row */}
            <div
              onClick={() => toggleExpand(entry.id)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.75rem 1rem',
                cursor: 'pointer',
                backgroundColor: expanded.has(entry.id) ? '#f0f0f0' : 'white',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ 
                  color: getStatusColor(entry.status),
                  fontWeight: 'bold',
                  fontSize: '1rem',
                }}>
                  {getStatusIcon(entry.status)}
                </span>
                <div>
                  <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 'bold' }}>
                    {(entry.total_input_nicks / 65536).toFixed(4)} NOCK
                  </p>
                  <p style={{ margin: 0, fontSize: '0.75rem', color: '#666' }}>
                    {formatDate(entry.broadcast_at)}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ 
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.5rem',
                  backgroundColor: getStatusColor(entry.status) + '22',
                  color: getStatusColor(entry.status),
                  borderRadius: '4px',
                  textTransform: 'uppercase',
                }}>
                  {entry.status}
                </span>
                <span style={{ color: '#999' }}>
                  {expanded.has(entry.id) ? '▲' : '▼'}
                </span>
              </div>
            </div>
            
            {/* Expanded details */}
            {expanded.has(entry.id) && (
              <div style={{
                padding: '1rem',
                borderTop: '1px solid #e0e0e0',
                backgroundColor: '#fafafa',
                fontSize: '0.875rem',
              }}>
                <div style={{ display: 'grid', gap: '0.5rem' }}>
                  <div>
                    <strong>Transaction ID:</strong>
                    <p style={{ margin: '0.25rem 0 0', fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                      {entry.tx_id}
                    </p>
                  </div>
                  
                  <div>
                    <strong>Wallet:</strong>
                    <p style={{ margin: '0.25rem 0 0', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {entry.lock_root_hash.substring(0, 24)}...
                    </p>
                  </div>
                  
                  <div>
                    <strong>Proposed by:</strong>
                    <p style={{ margin: '0.25rem 0 0', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {entry.proposer_pkh}
                    </p>
                  </div>
                  
                  <div>
                    <strong>Outputs:</strong>
                    {entry.seeds.map((seed, idx) => (
                      <p key={idx} style={{ margin: '0.25rem 0 0 0.5rem', fontSize: '0.75rem' }}>
                        → {(seed.amount_nicks / 65536).toFixed(4)} NOCK to{' '}
                        <span style={{ fontFamily: 'monospace' }}>
                          {seed.recipient.substring(0, 16)}...
                        </span>
                      </p>
                    ))}
                  </div>
                  
                  <div>
                    <strong>Signed by:</strong>
                    {entry.signers.map((signer, idx) => (
                      <p key={idx} style={{ margin: '0.25rem 0 0 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {signer === pkh ? `${signer} (you)` : signer}
                      </p>
                    ))}
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <div>
                      <strong>Created:</strong>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#666' }}>
                        {formatDate(entry.created_at)}
                      </p>
                    </div>
                    <div>
                      <strong>Broadcast:</strong>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#666' }}>
                        {formatDate(entry.broadcast_at)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

