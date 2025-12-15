import axios, { AxiosInstance, AxiosError } from 'axios';

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

 // one handler for errors coming from the server
  private handleError(error: unknown): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ error?: string; message?: string }>;
      
      // Server responded with an error
      if (axiosError.response?.data) {
        // Prioritize message field (user-friendly) over error code
        const errorMessage = axiosError.response.data.message || axiosError.response.data.error;
        
        if (errorMessage) {
          // Simplify message for existing multisig
          if (errorMessage.includes('already exists')) {
            throw new Error('A multisig with this configuration already exists');
          }
          throw new Error(errorMessage);
        }
      }
      
      // Network error or no response
      if (axiosError.request && !axiosError.response) {
        throw new Error('Network error: Unable to reach the server');
      }
      
      // Fallback for other axios errors
      throw new Error(axiosError.message || 'An unexpected error occurred');
    }
    
    // Re-throw if it's not an axios error
    throw error;
  }

  // Multisig spending condition endpoints
  async createMultisig(
    lockRootHash: string,
    threshold: number,
    totalSigners: number,
    signerPkhs: string[],
    createdByPkh: string
  ): Promise<{ id: string }> {
    try {
      const response = await this.client.post('/api/multisigs', {
        lock_root_hash: lockRootHash,
        threshold: threshold,
        total_signers: totalSigners,
        signer_pkhs: signerPkhs,
        created_by_pkh: createdByPkh,
      });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async listMultisigs(pkh?: string): Promise<any[]> {
    try {
      const params = pkh ? { pkh } : {};
      const response = await this.client.get('/api/multisigs', { params });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async getMultisig(id: string): Promise<any> {
    try {
      const response = await this.client.get(`/api/multisigs/${id}`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }
}

export const apiClient = new ApiClient();

