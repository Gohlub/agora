import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../services/api';
import { useWalletStore } from '../store/wallet';
import { wasm } from '@nockbox/iris-sdk';

export default function WalletCreate() {
  const [threshold, setThreshold] = useState(2);
  const { pkh } = useWalletStore();
  const [signerPkhs, setSignerPkhs] = useState<string[]>(pkh ? [pkh] : ['']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

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
      
      await wasm.default();
      

      const multisigPkh = new wasm.Pkh(BigInt(threshold), validPkhs);
      const lockPrimitive = wasm.LockPrimitive.newPkh(multisigPkh);
      const spendCondition = new wasm.SpendCondition([lockPrimitive]);
      
      const firstName = spendCondition.firstName();
      const lockRootHash = firstName.value;
      
      // create multisig spending condition
      await apiClient.createMultisig(
        lockRootHash,
        threshold, 
        validPkhs.length, 
        validPkhs, 
        pkh
      );
      
      // Clean 
      firstName.free();
      spendCondition.free();
      lockPrimitive.free();
      multisigPkh.free();
      
      navigate('/wallets');
    } catch (err: any) {
      setError(err.message || 'Failed to create wallet');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '2rem' }}>Create Multisig Wallet</h1>
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
            Threshold (m of n)
          </label>
          <input
            type="number"
            min="1"
            max={signerPkhs.length}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value) || 1)}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid #ddd',
              borderRadius: '4px',
            }}
          />
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: '#666' }}>
            {threshold} of {signerPkhs.length} signatures required
          </p>
        </div>
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
      </form>
    </div>
  );
}

