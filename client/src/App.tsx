import { BrowserRouter, Routes, Route } from 'react-router-dom';
import IrisConnect from './components/IrisConnect';
import WalletList from './components/WalletList';
import WalletCreate from './components/WalletCreate';
import Layout from './components/Layout';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<IrisConnect />} />
          <Route path="/wallets" element={<WalletList />} />
          <Route path="/wallets/create" element={<WalletCreate />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;

