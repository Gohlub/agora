import axios, { AxiosInstance } from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Multisig spending condition endpoints
  async createMultisig(lockRootHash: string, threshold: number, totalSigners: number, signerPkhs: string[], createdByPkh: string): Promise<{ id: string }> {
    const response = await this.client.post('/api/multisigs', {
      lock_root_hash: lockRootHash,
      threshold,
      total_signers: totalSigners,
      signer_pkhs: signerPkhs,
      created_by_pkh: createdByPkh,
    });
    return response.data;
  }

  async listMultisigs(pkh?: string): Promise<any[]> {
    const params = pkh ? { pkh } : {};
    const response = await this.client.get('/api/multisigs', { params });
    return response.data;
  }

  async getMultisig(id: string): Promise<any> {
    const response = await this.client.get(`/api/multisigs/${id}`);
    return response.data;
  }

}

export const apiClient = new ApiClient();

