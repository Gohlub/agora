import { Navigate } from 'react-router-dom';
import { useWalletStore } from '../store/wallet';

export default function Home() {
  const { pkh } = useWalletStore();

  if (pkh) {
    return <Navigate to="/wallets" replace />;
  }

  return (
    <div style={{ textAlign: 'center', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '1rem' }}>Agora - Multisig Wallet for Nockchain</h1>
      <div style={{ 
        marginTop: '2rem', 
        padding: '2rem', 
        backgroundColor: '#f8f9fa', 
        borderRadius: '8px',
        textAlign: 'left'
      }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Getting Started</h2>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.6' }}>
          To begin using Agora, you need to connect your Iris wallet extension.
        </p>
        <ol style={{ marginLeft: '1.5rem', color: '#666', lineHeight: '1.8' }}>
          <li style={{ marginBottom: '0.5rem' }}>Make sure you have the Iris wallet extension installed in your browser</li>
          <li style={{ marginBottom: '0.5rem' }}>Click the "Connect Wallet" button in the top right corner</li>
          <li style={{ marginBottom: '0.5rem' }}>Approve the connection request in your wallet extension</li>
          <li>Once connected, you can create and manage multisig wallets</li>
        </ol>
      </div>
    </div>
  );
}
