import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useWalletStore } from '../store/wallet';
import WalletConnectButton from './IrisConnectButton';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { pkh } = useWalletStore();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        background: '#fff',
        borderBottom: '1px solid #e0e0e0',
        padding: '1rem 2rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <Link to="/" style={{ textDecoration: 'none', color: '#333', fontSize: '1.5rem', fontWeight: 'bold' }}>
          Agora
        </Link>
        <nav style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {pkh && (
            <>
              <Link to="/wallets" style={{ textDecoration: 'none', color: '#333' }}>Wallets</Link>
            </>
          )}
          <WalletConnectButton />
        </nav>
      </header>
      <main style={{ flex: 1, padding: '2rem', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
        {children}
      </main>
    </div>
  );
}

