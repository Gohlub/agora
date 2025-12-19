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
  ): Promise<{ lock_root_hash: string }> {
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

  async getMultisig(lockRootHash: string): Promise<any> {
    try {
      const response = await this.client.get(`/api/multisigs/${lockRootHash}`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  // === Proposal endpoints ===

  async createProposal(data: {
    tx_id: string;
    lock_root_hash: string;
    proposer_pkh: string;
    threshold: number;
    raw_tx_json: string;
    notes_json: string;
    spend_conditions_json: string;
    total_input_nicks: number;
    seeds: Array<{ recipient: string; amount_nicks: number }>;
    proposer_signed_tx_json: string; // Proposer signs at creation
  }): Promise<{ id: string; tx_id: string }> {
    try {
      const response = await this.client.post('/api/proposals', data);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async listProposals(params?: {
    pkh?: string;
    lock_root_hash?: string;
    status?: string;
  }): Promise<any[]> {
    try {
      const response = await this.client.get('/api/proposals', { params });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async getProposal(id: string): Promise<any> {
    try {
      const response = await this.client.get(`/api/proposals/${id}`);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async signProposal(id: string, signerPkh: string, signedTxJson: string): Promise<{
    success: boolean;
    signatures_collected: number;
    ready_to_broadcast: boolean;
  }> {
    try {
      const response = await this.client.post(`/api/proposals/${id}/sign`, {
        signer_pkh: signerPkh,
        signed_tx_json: signedTxJson,
      });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async markProposalBroadcast(id: string, broadcasterPkh: string, finalTxId?: string): Promise<any> {
    try {
      const payload = {
        _broadcaster_pkh: broadcasterPkh, // Note: server expects underscore prefix
        final_tx_id: finalTxId,
      };
      const response = await this.client.post(`/api/proposals/${id}/broadcast`, payload);
      return response.data;
    } catch (error) {
      const axiosError = error as any;
      if (axiosError.response?.data) {
        console.error('markProposalBroadcast error response:', axiosError.response.data);
      }
      this.handleError(error);
    }
  }

  // Direct spend for 1-of-n wallets - bypasses proposal flow
  async directSpend(data: {
    tx_id: string;
    lock_root_hash: string;
    sender_pkh: string;
    total_input_nicks: number;
    seeds: Array<{ recipient: string; amount_nicks: number }>;
  }): Promise<{ success: boolean; history_id: string }> {
    try {
      const response = await this.client.post('/api/proposals/direct', data);
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }

  async getTransactionHistory(params?: {
    pkh?: string;
    lock_root_hash?: string;
  }): Promise<any[]> {
    try {
      const response = await this.client.get('/api/proposals/history', { params });
      return response.data;
    } catch (error) {
      this.handleError(error);
    }
  }
}

export const apiClient = new ApiClient();

