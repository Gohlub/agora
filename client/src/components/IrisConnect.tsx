import { useState } from 'react';
import { NockchainProvider } from '@nockbox/iris-sdk';
import { useWalletStore } from '../store/wallet';
import { useNavigate } from 'react-router-dom';

export default function IrisConnect() {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setWallet, pkh } = useWalletStore();
  const navigate = useNavigate();

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      // connect wallet
      const provider = new NockchainProvider();
      const { pkh: walletPkh, grpcEndpoint } = await provider.connect();

      // store wallet info
      setWallet(walletPkh, grpcEndpoint);

      // navigate to wallets
      navigate('/wallets');
    } catch (err: any) {
      setError(err.message || 'Failed to connect wallet');
      console.error('Connection error:', err);
    } finally {
      setConnecting(false);
    }
  };

  if (pkh) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <h1>Connected</h1>
        <p style={{ marginTop: '1rem', color: '#666' }}>
          Wallet: {pkh ? `${pkh.substring(0, 16)}...${pkh.substring(pkh.length - 8)}` : 'Unknown'}
        </p>
        <button
          onClick={() => navigate('/wallets')}
          style={{
            marginTop: '2rem',
            padding: '0.75rem 1.5rem',
            fontSize: '1rem',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Go to Wallets
        </button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '2rem', maxWidth: '500px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '1rem' }}>Agora - Multisig Wallet for Nockchain</h1>
      <p style={{ marginBottom: '2rem', color: '#666' }}>
        Connect your Iris wallet to begin!
      </p>
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
      <button
        onClick={handleConnect}
        disabled={connecting}
        style={{
          padding: '0.75rem 1.5rem',
          fontSize: '1rem',
          backgroundColor: connecting ? '#ccc' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: connecting ? 'not-allowed' : 'pointer',
        }}
      >
        {connecting ? 'Connecting...' : 'Connect Wallet'}
      </button>
    </div>
  );
}
