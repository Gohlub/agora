import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import WalletList from './components/WalletList';
import WalletCreate from './components/WalletCreate';
import Layout from './components/Layout';

function App() {
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/wallets" element={<WalletList />} />
          <Route path="/wallets/create" element={<WalletCreate />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;

