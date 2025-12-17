import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { useWasmCleanup, computeLockRootHash } from '../utils/wasm-utils';

export default function WalletCreate() {
  const [threshold, setThreshold] = useState(2);
  const { pkh } = useWalletStore();
  const [signerPkhs, setSignerPkhs] = useState<string[]>(pkh ? [pkh] : ['']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const wasmCleanup = useWasmCleanup();

  // Update first signer when wallet connects/disconnects
  useEffect(() => {
    if (pkh) {
      setSignerPkhs(prev => {
        // If first signer is empty or different, update it
        if (prev[0] === '' || prev[0] !== pkh) {
          return [pkh, ...prev.slice(1)];
        }
        return prev;
      });
    } else {
      // If wallet disconnects, clear first signer
      setSignerPkhs(prev => ['', ...prev.slice(1)]);
    }
  }, [pkh]);

  // Adjust threshold if it exceeds number of signers
  useEffect(() => {
    if (threshold > signerPkhs.length) {
      setThreshold(signerPkhs.length);
    }
  }, [signerPkhs.length, threshold]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  const addSigner = () => {
    setSignerPkhs([...signerPkhs, '']);
  };

  const updateSigner = (index: number, value: string) => {
    const updated = [...signerPkhs];
    updated[index] = value;
    setSignerPkhs(updated);
  };

  const removeSigner = (index: number) => {
    // Don't allow removing the first signer if it's the connected wallet
    if (index === 0 && pkh && signerPkhs[0] === pkh) {
      return;
    }
    setSignerPkhs(signerPkhs.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const validPkhs = signerPkhs.filter(pkh => pkh.trim() !== '');
      if (validPkhs.length === 0) {
        throw new Error('At least one signer PKH is required');
      }
      if (threshold < 1 || threshold > validPkhs.length) {
        throw new Error(`Threshold must be between 1 and ${validPkhs.length}`);
      }

      if (!pkh) {
        throw new Error('Wallet not connected');
      }
      
      console.log('Creating multisig with participants:', validPkhs);
      
      const lockRootHash = await computeLockRootHash(threshold, validPkhs, wasmCleanup);
      
      // create multisig spending condition
      await apiClient.createMultisig(
        lockRootHash,
        threshold, 
        validPkhs.length, 
        validPkhs, 
        pkh
      );
      
      setLoading(false);
      navigate('/wallets');
    } catch (err: any) {
      setError(err.message || 'Failed to create wallet');
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '2rem' }}>Create a multisig wallet</h1>
      {error && (
        <div style={{
          padding: '1rem',
          backgroundColor: '#fee',
          color: '#c33',
          borderRadius: '4px',
          marginBottom: '1rem',
        }}>
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Signer PKHs
          </label>
          {signerPkhs.map((signerPkh, index) => (
            <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="text"
                value={signerPkh}
                onChange={(e) => updateSigner(index, e.target.value)}
                placeholder="Enter PKH address"
                disabled={index === 0 && !!pkh && signerPkhs[0] === pkh}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  backgroundColor: index === 0 && !!pkh && signerPkhs[0] === pkh ? '#f5f5f5' : 'white',
                  cursor: index === 0 && !!pkh && signerPkhs[0] === pkh ? 'not-allowed' : 'text',
                }}
              />
              {signerPkhs.length > 1 && !(index === 0 && pkh && signerPkhs[0] === pkh) && (
                <button
                  type="button"
                  onClick={() => removeSigner(index)}
                  style={{
                    padding: '0.75rem',
                    backgroundColor: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addSigner}
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 1rem',
              backgroundColor: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Add Signer
          </button>
        </div>
        <hr style={{
          border: 'none',
          borderTop: '1px solid #e0e0e0',
          margin: '2rem 0',
        }} />
        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Threshold (m of n)
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
                <button
                  type="button"
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  style={{
                    padding: '0.75rem 2.5rem 0.75rem 0.75rem',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    fontSize: '1rem',
                    cursor: 'pointer',
                    backgroundColor: 'white',
                    color: '#333',
                    minWidth: '50px',
                    textAlign: 'left',
                    transition: 'border-color 0.2s ease',
                    borderColor: dropdownOpen ? '#007bff' : '#ddd',
                  }}
                >
                  {threshold}
                  <span style={{
                    position: 'absolute',
                    right: '0.75rem',
                    top: '50%',
                    transform: dropdownOpen ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%)',
                    transition: 'transform 0.2s ease',
                  }}>
                    ▼
                  </span>
                </button>
                {dropdownOpen && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    marginTop: '0.25rem',
                    backgroundColor: 'white',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
                    zIndex: 1000,
                    maxHeight: '200px',
                    overflowY: 'auto',
                  }}>
                    {Array.from({ length: signerPkhs.length }, (_, i) => i + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setThreshold(value);
                          setDropdownOpen(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '0.75rem',
                          textAlign: 'left',
                          border: 'none',
                          backgroundColor: value === threshold ? '#f0f0f0' : 'white',
                          color: '#333',
                          cursor: 'pointer',
                          fontSize: '1rem',
                          transition: 'background-color 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (value !== threshold) {
                            e.currentTarget.style.backgroundColor = '#f8f8f8';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (value !== threshold) {
                            e.currentTarget.style.backgroundColor = 'white';
                          }
                        }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#666' }}>
                of {signerPkhs.length} signatures required
              </p>
            </div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="submit"
                disabled={loading}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: loading ? '#ccc' : '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                }}
              >
                {loading ? 'Creating...' : 'Create Wallet'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/wallets')}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: '#6c757d',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

