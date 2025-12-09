import axios from 'axios';
import {
  CopyrightApiResponse,
  DocumentCopyright,
  DocumentMetadata,
  CopyrightStats,
  CopyrightSearchFilters,
  CopyrightSearchResult,
  CopyrightAnalytics,
  CopyrightRegistrationResult,
  CopyrightVerificationResult
} from '../../types/copyright';

// URL trỏ vào API Gateway (Ngrok URL khi deploy)
const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'}/api/copyrights`;

const copyrightApi = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    // Header này để bypass trang cảnh báo của Ngrok
    'ngrok-skip-browser-warning': 'true',
  },
  // --- QUAN TRỌNG: TẮT CREDENTIALS VÌ BẠN DÙNG TOKEN HEADER ---
  withCredentials: false
});

// Request interceptor: Lấy Token từ localStorage
copyrightApi.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
copyrightApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('authToken');
      if (window.location.pathname !== '/auth') {
        window.location.href = '/auth';
      }
    }
    return Promise.reject(error);
  }
);

/**
 * Copyright API Service
 */
class CopyrightApiService {
  async registerDocument(
    file: File,
    metadata: DocumentMetadata
  ): Promise<CopyrightApiResponse<CopyrightRegistrationResult>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('metadata', JSON.stringify(metadata));

    const response = await copyrightApi.post('/register', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });

    return response.data;
  }

  async registerTextDocument(
    content: string,
    metadata: DocumentMetadata
  ): Promise<CopyrightApiResponse<CopyrightRegistrationResult>> {
    const response = await copyrightApi.post('/register-text', {
      content,
      metadata,
    });

    return response.data;
  }

  async verifyDocument(
    documentHash: string
  ): Promise<CopyrightApiResponse<CopyrightVerificationResult>> {
    const response = await copyrightApi.post(`/verify/${documentHash}`);
    return response.data;
  }

  async getDocument(
    documentHash: string
  ): Promise<CopyrightApiResponse<DocumentCopyright>> {
    const response = await copyrightApi.get(`/document/${documentHash}`);
    return response.data;
  }

  async documentExists(
    documentHash: string
  ): Promise<CopyrightApiResponse<{ exists: boolean }>> {
    const response = await copyrightApi.get(`/exists/${documentHash}`);
    return response.data;
  }

  async getUserDocuments(
    address: string,
    page: number = 1,
    limit: number = 20
  ): Promise<CopyrightApiResponse<CopyrightSearchResult>> {
    const response = await copyrightApi.get(`/user/${address}`, {
      params: { page, limit },
    });
    return response.data;
  }

  async getCategoryDocuments(
    category: string,
    page: number = 1,
    limit: number = 20
  ): Promise<CopyrightApiResponse<CopyrightSearchResult>> {
    const response = await copyrightApi.get(`/category/${category}`, {
      params: { page, limit },
    });
    return response.data;
  }

  async searchDocuments(
    filters: CopyrightSearchFilters,
    page: number = 1,
    limit: number = 20
  ): Promise<CopyrightApiResponse<CopyrightSearchResult>> {
    const response = await copyrightApi.post('/search', {
      filters,
      page,
      limit,
    });
    return response.data;
  }

  async getStatistics(): Promise<CopyrightApiResponse<CopyrightStats>> {
    const response = await copyrightApi.get('/statistics');
    return response.data;
  }

  async getAnalytics(
    dateFrom?: number,
    dateTo?: number
  ): Promise<CopyrightApiResponse<CopyrightAnalytics>> {
    const response = await copyrightApi.get('/analytics', {
      params: { dateFrom, dateTo },
    });
    return response.data;
  }

  async updateDocument(
    documentHash: string,
    field: 'title' | 'description',
    value: string
  ): Promise<CopyrightApiResponse<{ success: boolean }>> {
    const response = await copyrightApi.put(`/document/${documentHash}`, {
      field,
      value,
    });
    return response.data;
  }

  async updateDocumentTags(
    documentHash: string,
    tags: string[]
  ): Promise<CopyrightApiResponse<{ success: boolean }>> {
    const response = await copyrightApi.put(`/document/${documentHash}/tags`, {
      tags,
    });
    return response.data;
  }

  async deactivateDocument(
    documentHash: string
  ): Promise<CopyrightApiResponse<{ success: boolean }>> {
    const response = await copyrightApi.delete(`/document/${documentHash}`);
    return response.data;
  }

  async uploadToIPFS(file: File): Promise<CopyrightApiResponse<{ ipfsHash: string }>> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await copyrightApi.post('/ipfs/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }

  async getFromIPFS(ipfsHash: string): Promise<Blob> {
    const response = await copyrightApi.get(`/ipfs/${ipfsHash}`, {
      responseType: 'blob',
    });
    return response.data;
  }

  async calculateFileHash(file: File): Promise<CopyrightApiResponse<{ hash: string }>> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await copyrightApi.post('/hash/calculate', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }

  async calculateTextHash(content: string): Promise<CopyrightApiResponse<{ hash: string }>> {
    const response = await copyrightApi.post('/hash/text', {
      content,
    });
    return response.data;
  }

  async getTransactionHistory(
    address: string,
    page: number = 1,
    limit: number = 20
  ): Promise<CopyrightApiResponse<{
    transactions: Array<{
      hash: string;
      type: 'register' | 'verify' | 'update';
      documentHash: string;
      timestamp: number;
      status: 'pending' | 'confirmed' | 'failed';
    }>;
    total: number;
  }>> {
    const response = await copyrightApi.get(`/transactions/${address}`, {
      params: { page, limit },
    });
    return response.data;
  }

  async getTransactionFees(): Promise<CopyrightApiResponse<{
    registrationFee: string;
    verificationFee: string;
    gasPrice: string;
  }>> {
    const response = await copyrightApi.get('/fees');
    return response.data;
  }

  async getTransactionStatus(
    transactionHash: string
  ): Promise<CopyrightApiResponse<{
    status: 'pending' | 'confirmed' | 'failed';
    blockNumber?: number;
    gasUsed?: string;
  }>> {
    const response = await copyrightApi.get(`/transaction/${transactionHash}/status`);
    return response.data;
  }

  async getContractInfo(): Promise<CopyrightApiResponse<{
    address: string;
    abi: any;
    network: string;
    version: string;
  }>> {
    const response = await copyrightApi.get('/contract/info');
    return response.data;
  }

  async getContractEvents(
    eventType: 'DocumentRegistered' | 'DocumentVerified',
    fromBlock?: number,
    toBlock?: number
  ): Promise<CopyrightApiResponse<Array<{
    transactionHash: string;
    blockNumber: number;
    eventType: string;
    data: any;
    timestamp: number;
  }>>> {
    const response = await copyrightApi.get('/contract/events', {
      params: { eventType, fromBlock, toBlock },
    });
    return response.data;
  }

  async exportData(
    format: 'json' | 'csv',
    filters?: CopyrightSearchFilters
  ): Promise<Blob> {
    const response = await copyrightApi.post('/export', {
      format,
      filters,
    }, {
      responseType: 'blob',
    });
    return response.data;
  }

  async importData(
    file: File,
    options: {
      validateHashes: boolean;
      skipExisting: boolean;
    }
  ): Promise<CopyrightApiResponse<{
    imported: number;
    skipped: number;
    errors: string[];
  }>> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('options', JSON.stringify(options));

    const response = await copyrightApi.post('/import', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }

  async getReport(
    type: 'daily' | 'weekly' | 'monthly' | 'yearly',
    date?: string
  ): Promise<CopyrightApiResponse<{
    period: string;
    stats: CopyrightStats;
    analytics: CopyrightAnalytics;
  }>> {
    const response = await copyrightApi.get('/reports', {
      params: { type, date },
    });
    return response.data;
  }

  async sendNotification(
    type: 'email' | 'push',
    recipients: string[],
    message: string
  ): Promise<CopyrightApiResponse<{ sent: number; failed: number }>> {
    const response = await copyrightApi.post('/notifications', {
      type,
      recipients,
      message,
    });
    return response.data;
  }
}

export const copyrightApiService = new CopyrightApiService();
export default copyrightApiService;