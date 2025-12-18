import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletStore } from '../store/wallet';
import { NockchainProvider } from '@nockbox/iris-sdk';
import walletIcon from '../assets/wallet-icon.svg'; // or .png, .jpg, etc.

export default function WalletConnectButton() {
  const { pkh, setWallet, clearWallet } = useWalletStore();
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState(false);
  const [_error, setError] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isDisconnectHovered, setIsDisconnectHovered] = useState(false);

  // Verify stored wallet connection is still valid on mount
  useEffect(() => {
    const verifyConnection = async () => {
      if (!pkh) return;

      try {
        new NockchainProvider();
      } catch (err) {
        clearWallet();
      }
    };

    verifyConnection();
  }, [pkh, clearWallet]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);

    try {
      const provider = new NockchainProvider();
      const { pkh: walletPkh, grpcEndpoint } = await provider.connect();
      setWallet(walletPkh, grpcEndpoint);
    } catch (err: any) {
      setError(err.message || 'Failed to connect wallet');
      console.error('Connection error:', err);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    clearWallet();
    navigate('/');
  };

  if (pkh) {
    return (
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <span style={{ fontSize: '0.875rem', color: '#666' }}>
          {`${pkh.substring(0, 8)}...${pkh.substring(pkh.length - 8)}`}
        </span>
        <button
          onClick={handleDisconnect}
          onMouseEnter={() => setIsDisconnectHovered(true)}
          onMouseLeave={() => setIsDisconnectHovered(false)}
          style={{
            padding: '16px 20px 16px 16px',
            fontFamily: 'Inter',
            fontWeight: 500,
            fontSize: '17px',
            lineHeight: '24px',
            letterSpacing: '-0.02em',
            color: '#333333',
            backgroundColor: isDisconnectHovered ? '#E8E7E3' : '#F6F5F1',
            border: 'none',
            borderRadius: '28px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            boxSizing: 'border-box',
            margin: 0,
            transition: 'background-color 0.2s ease',
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleConnect}
      disabled={connecting}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '16px 20px 16px 16px', 
        fontFamily: 'Inter',
        fontWeight: 500, 
        fontSize: '17px',
        lineHeight: '24px',
        letterSpacing: '-0.02em',
        color: '#333333', 
        backgroundColor: connecting 
          ? '#ccc' 
          : isHovered 
            ? '#E8E7E3' 
            : '#F6F5F1', 
        border: 'none',
        borderRadius: '28px',
        cursor: connecting ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        boxSizing: 'border-box',
        margin: 0,
        transition: 'background-color 0.2s ease', 
      }}
    >
      <img 
        src={walletIcon} 
        alt="Wallet" 
        style={{ 
          width: '24px', 
          height: '24px',
          display: 'block', // Remove any inline spacing
        }} 
      />
      {connecting ? 'Connecting...' : 'Iris Connect'}
    </button>
  );
}
