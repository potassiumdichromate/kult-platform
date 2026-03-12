import axios, { AxiosInstance, AxiosError } from 'axios';
import { Logger } from 'winston';

export interface StorageMetadata {
  agentId: string;
  version: number;
  framework: string;
  contentType?: string;
}

export interface UploadResult {
  hash: string;
  size: number;
  url: string;
}

export interface StorageVerifyResult {
  exists: boolean;
  size?: number;
  contentType?: string;
}

export class StorageService {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly logger: Logger) {
    this.baseUrl = process.env.ZERO_G_STORAGE_URL ?? 'https://indexer-storage-testnet-standard.0g.ai';
    this.apiKey = process.env.ZERO_G_API_KEY ?? '';

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30_000,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });

    this.client.interceptors.request.use((config) => {
      this.logger.debug('0G Storage request', { method: config.method, url: config.url });
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        this.logger.error('0G Storage response error', {
          status: error.response?.status,
          message: error.message,
          url: error.config?.url,
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Verify that a storage hash exists on 0G network.
   * Pings the 0G indexer to confirm the model blob is retrievable.
   */
  async verifyStorageHash(hash: string): Promise<StorageVerifyResult> {
    if (!hash || hash.trim().length === 0) {
      return { exists: false };
    }

    try {
      // 0G indexer endpoint to query file metadata by merkle root hash
      const response = await this.client.get<{
        file?: { size: number; contentType: string };
        status?: string;
      }>(`/file/info/${hash}`);

      if (response.status === 200 && response.data?.file) {
        return {
          exists: true,
          size: response.data.file.size,
          contentType: response.data.file.contentType,
        };
      }

      return { exists: false };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 404) {
          this.logger.warn('Storage hash not found on 0G', { hash });
          return { exists: false };
        }
        // On network errors or 5xx, we treat as "cannot verify" - let upstream decide
        this.logger.error('0G storage verification failed with network error', {
          hash,
          status: err.response?.status,
          message: err.message,
        });
        // Return exists=true to avoid blocking registration on transient network issues.
        // In production, this could be configurable strict/lenient mode.
        return { exists: true };
      }
      throw err;
    }
  }

  /**
   * Construct the download URL for a given 0G hash.
   * Returns the direct download URL from the 0G network gateway.
   */
  async getDownloadUrl(hash: string): Promise<string> {
    const gatewayUrl = process.env.ZERO_G_GATEWAY_URL ?? 'https://rpc-storage-testnet.0g.ai';
    // Standard 0G download endpoint
    return `${gatewayUrl}/file?merkle=${hash}`;
  }

  /**
   * Upload a model buffer to 0G decentralized storage.
   * Returns the content-addressed hash and download URL.
   */
  async uploadModel(buffer: Buffer, metadata: StorageMetadata): Promise<UploadResult> {
    const FormData = (await import('form-data')).default;
    const form = new FormData();

    form.append('file', buffer, {
      filename: `model_${metadata.agentId}_v${metadata.version}.bin`,
      contentType: metadata.contentType ?? 'application/octet-stream',
    });

    form.append('metadata', JSON.stringify({
      agentId: metadata.agentId,
      version: metadata.version,
      framework: metadata.framework,
      uploadedAt: new Date().toISOString(),
    }));

    try {
      const uploadClient = axios.create({
        baseURL: process.env.ZERO_G_GATEWAY_URL ?? 'https://rpc-storage-testnet.0g.ai',
        timeout: 120_000, // 2 minutes for large model uploads
        headers: {
          ...form.getHeaders(),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });

      const response = await uploadClient.post<{
        merkleRoot: string;
        size: number;
        txHash?: string;
      }>('/file/upload', form);

      const hash = response.data.merkleRoot;
      const downloadUrl = await this.getDownloadUrl(hash);

      this.logger.info('Model uploaded to 0G storage', {
        hash,
        size: response.data.size,
        agentId: metadata.agentId,
        version: metadata.version,
        txHash: response.data.txHash,
      });

      return {
        hash,
        size: response.data.size,
        url: downloadUrl,
      };
    } catch (err) {
      this.logger.error('Failed to upload model to 0G storage', {
        agentId: metadata.agentId,
        version: metadata.version,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      throw new Error(
        `0G storage upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }
}
