import { BrowserRouter, Routes, Route } from 'react-router-dom';
import IrisConnect from './components/IrisConnect';
import Layout from './components/Layout';

function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<IrisConnect />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

export default App;

