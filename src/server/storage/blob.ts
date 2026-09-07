import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import {
  AudioSizeLimitError,
  limitAudioStream,
  MAX_AUDIO_SIZE,
  validateBlobName,
} from './audio-policy.js';

let blobServiceClient: BlobServiceClient | null = null;

function getClient(): BlobServiceClient {
  if (!blobServiceClient) {
    const connectionString = config.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error('Azure Blob Storage is not configured');
    }
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  }
  return blobServiceClient;
}

function getContainerClient() {
  return getClient().getContainerClient(config.AZURE_STORAGE_CONTAINER);
}

/**
 * Parse account name and key from the connection string for Service SAS signing.
 * This is intentionally isolated so it can be replaced by a User Delegation SAS
 * signer without changing callers.
 */
function getSharedKeyCredential(): StorageSharedKeyCredential {
  const connectionString = config.AZURE_STORAGE_CONNECTION_STRING || '';
  const accountName = connectionString.match(/(?:^|;)AccountName=([^;]+)/)?.[1];
  const accountKey = connectionString.match(/(?:^|;)AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) {
    throw new Error('Azure Storage connection string is missing AccountName or AccountKey');
  }
  return new StorageSharedKeyCredential(accountName, accountKey);
}

export async function uploadAudio(
  stream: Readable,
  blobName: string,
  contentType: string,
  size?: number,
): Promise<string> {
  const safeBlobName = validateBlobName(blobName);
  if (size !== undefined && size > MAX_AUDIO_SIZE) {
    throw new AudioSizeLimitError();
  }

  const container = getContainerClient();
  const blockBlobClient = container.getBlockBlobClient(safeBlobName);

  try {
    await blockBlobClient.uploadStream(limitAudioStream(stream), 4 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  } catch (error) {
    await blockBlobClient.deleteIfExists().catch(() => undefined);
    throw error;
  }

  return safeBlobName;
}

export async function uploadAudioBuffer(
  buffer: Buffer,
  blobName: string,
  contentType: string,
): Promise<string> {
  if (buffer.length > MAX_AUDIO_SIZE) {
    throw new AudioSizeLimitError();
  }

  const safeBlobName = validateBlobName(blobName);
  const container = getContainerClient();
  const blockBlobClient = container.getBlockBlobClient(safeBlobName);

  try {
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  } catch (error) {
    await blockBlobClient.deleteIfExists().catch(() => undefined);
    throw error;
  }

  return safeBlobName;
}

/**
 * Generate a read-only, HTTPS-only Service SAS URL for one blob.
 * The access window is configured from issuance, with a small start-time
 * buffer for clock skew between the application and Azure Storage.
 */
export function generateSasUrl(blobName: string): string {
  const safeBlobName = validateBlobName(blobName);
  const credential = getSharedKeyCredential();
  const container = getContainerClient();
  const blobClient = container.getBlobClient(safeBlobName);
  const now = Date.now();
  const startsOn = new Date(now - config.AUDIO_SAS_CLOCK_SKEW_MINUTES * 60 * 1000);
  const expiresOn = new Date(now + config.AUDIO_SAS_EXPIRY_MINUTES * 60 * 1000);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: config.AZURE_STORAGE_CONTAINER,
      blobName: safeBlobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    credential,
  ).toString();

  return `${blobClient.url}?${sasToken}`;
}

export async function containerExists(): Promise<boolean> {
  return getContainerClient().exists();
}

export async function blobExists(blobName: string): Promise<boolean> {
  const container = getContainerClient();
  const blobClient = container.getBlobClient(validateBlobName(blobName));
  return blobClient.exists();
}

export async function deleteBlob(blobName: string): Promise<void> {
  const container = getContainerClient();
  const blobClient = container.getBlobClient(validateBlobName(blobName));
  await blobClient.deleteIfExists();
}

/**
 * Container provisioning is intentionally manual. This helper is retained for
 * operational scripts but is never called during application startup or import.
 */
export async function ensureContainer(): Promise<void> {
  const container = getContainerClient();
  await container.createIfNotExists({ access: undefined });
}

export function isBlobStorageConfigured(): boolean {
  return Boolean(config.AZURE_STORAGE_CONNECTION_STRING);
}
