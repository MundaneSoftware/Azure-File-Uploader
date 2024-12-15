import { EventEmitter } from 'events';
import { ShareFileClient } from '@azure/storage-file-share';
import { BlockBlobClient } from '@azure/storage-blob';
import { splitFileIntoChunks, determineConcurrency } from './utils.js';

export default class Uploader extends EventEmitter {
    constructor({
        maxConcurrentUploads = 5,
        destinationResolver,
        refreshSasToken,
        storageType = 'blob', // Can be 'blob' or 'file'
        infoLogger = console.info,
        errorLogger = console.error,
        progressStore = window.localStorage, // Use localStorage by default
        adaptiveConcurrency = true,
        maxChunkSize = 4 * 1024 * 1024, // Default chunk size: 4MB
        minChunkSize = 1 * 1024 * 1024, // Minimum chunk size: 1MB
        renewalPeriod = 4 * 60 * 1000, // SAS token renewal every 4 minutes
    }) {
        super();
        this.defaultConcurrency = maxConcurrentUploads;
        this.currentConcurrency = determineConcurrency(maxConcurrentUploads);
        this.destinationResolver = destinationResolver;
        this.refreshSasToken = refreshSasToken;
        this.storageType = storageType;
        this.infoLogger = infoLogger;
        this.errorLogger = errorLogger;
        this.progressStore = progressStore;
        this.resumeData = {};
        this.cancelledFiles = new Set();
        this.pausedFiles = new Set();
        this.adaptiveConcurrency = adaptiveConcurrency;
        this.maxChunkSize = maxChunkSize;
        this.minChunkSize = minChunkSize;
        this.renewalPeriod = renewalPeriod;
        this.startTime = Date.now();
        this.sasToken = null;
        this.recoveryTimer = null;
    }

    logInfo(message, data = null) {
        this.infoLogger(message, data);
    }

    logError(message, error) {
        this.errorLogger(message, error);
    }

    calculateSpeedAndETA(uploadedBytes, totalBytes, startTime) {
        const elapsedTime = (Date.now() - startTime) / 1000; // In seconds
        const speed = uploadedBytes / elapsedTime; // Bytes per second
        const remainingBytes = totalBytes - uploadedBytes;
        const eta = remainingBytes / speed; // In seconds

        return {
            speed: (speed / 1024 / 1024).toFixed(2), // Speed in MB/s
            eta: Math.max(0, eta).toFixed(0), // ETA in seconds
        };
    }

    loadProgress(fileName, fileSize) {
        const progress = this.progressStore.getItem(`uploader_progress_${fileName}`);
        if (progress) {
            const parsed = JSON.parse(progress);
            if (parsed.fileSize === fileSize) {
                return parsed;
            } else {
                this.progressStore.removeItem(`uploader_progress_${fileName}`);
            }
        }
        return null;
    }

    saveProgress(fileName, fileSize, uploadedChunks, startTime) {
        this.progressStore.setItem(
            `uploader_progress_${fileName}`,
            JSON.stringify({
                fileSize,
                uploadedChunks: Array.from(uploadedChunks),
                startTime,
                timestamp: Date.now(),
            })
        );
    }

    getOptimalChunkSize(fileSize) {
        if (fileSize < this.maxChunkSize) {
            return Math.max(this.minChunkSize, Math.floor(fileSize / 10));
        }
        return this.maxChunkSize;
    }

    async checkForSasRenewal() {
        const currentTime = Date.now();
        if (currentTime - this.startTime >= this.renewalPeriod) {
            this.logInfo('SAS token expired, requesting renewal...');
            this.sasToken = await this.refreshSasToken(); // Use refreshSasToken to renew
            this.startTime = Date.now(); // Reset start time
        }
    }

    async cleanupFile(fileName, destinationPath) {
        const sasToken = await this.refreshSasToken(fileName);
        const storageUrl = `${destinationPath}/${fileName}${sasToken}`;
        const client = this.initializeClient(storageUrl);

        try {
            await client.delete();
            this.logInfo(`Cleaned up partially uploaded file: ${fileName}`);
        } catch (error) {
            this.logError(`Failed to clean up file: ${fileName}`, error);
        }
    }

    async uploadFiles(files) {
        const uploadPromises = files.map((file) => this.uploadFile(file));
        return Promise.allSettled(uploadPromises);
    }

    async cancelUpload(fileName) {
        if (!this.resumeData[fileName]) {
            this.logInfo(`No active upload found for ${fileName}.`);
            return;
        }

        // Mark the file as cancelled
        this.cancelledFiles.add(fileName);
        this.logInfo(`Upload for ${fileName} has been cancelled.`);

        // Clean up the progress and resume data
        this.progressStore.removeItem(`uploader_progress_${fileName}`);
        delete this.resumeData[fileName];
    }

    async uploadFile(file) {

        if (this.resumeData[file.name]?.inProgress) {
            this.logInfo(`Upload for ${file.name} is already in progress.`);
            return;
        }
        this.resumeData[file.name] = {
            ...this.resumeData[file.name],
            inProgress: true,
        };

        const destinationPath = await this.destinationResolver(file);
        this.sasToken = await this.refreshSasToken(file.name); // Initial SAS token fetch
        const storageUrl = `${destinationPath}/${file.name}${this.sasToken}`;
    
        const persistedProgress = this.loadProgress(file.name, file.size);
        const uploadedChunks = new Set(persistedProgress?.uploadedChunks || []);
        this.resumeData[file.name] = {
            file,
            uploadedChunks,
            startTime: persistedProgress?.startTime || Date.now(),
        };
    
        const chunkSize = this.getOptimalChunkSize(file.size);
        const chunks = splitFileIntoChunks(file, chunkSize);
    
        this.logInfo(`Starting upload for ${file.name}`);
        this.emit('fileStart', { fileName: file.name, totalChunks: chunks.length });
    
        const client = this.initializeClient(storageUrl);
        if (this.storageType === 'file') {
            await client.create(file.size); // Pre-create file if using Azure File Share
        }
    
        const uploadPool = [];
        const startTime = this.resumeData[file.name].startTime;
        let uploadedBytes = Array.from(uploadedChunks).reduce(
            (sum, chunkIndex) => sum + chunks[chunkIndex].size,
            0
        );
    
        try {
            for (let i = 0; i < chunks.length; i++) {
                if (this.pausedFiles.has(file.name)) {
                    this.logInfo(`Upload for ${file.name} paused.`);
                    return;
                }
    
                if (this.cancelledFiles.has(file.name)) {
                    this.logInfo(`Upload for ${file.name} cancelled.`);
                    throw new Error('Upload cancelled');
                }
    
                // Skip already uploaded chunks
                if (uploadedChunks.has(i)) continue;
    
                // Maintain concurrency
                if (uploadPool.length >= this.currentConcurrency) {
                    await Promise.race(uploadPool);
                }
    
                const startRange = i * chunkSize;
                const endRange = startRange + chunks[i].size - 1;
    
                const chunkUploadPromise = this.uploadChunk(client, chunks[i], i, startRange, endRange)
                    .then(() => {
                        uploadedChunks.add(i);
                        this.resumeData[file.name].uploadedChunks = uploadedChunks;
                        uploadedBytes += chunks[i].size;
    
                        this.saveProgress(file.name, file.size, uploadedChunks, startTime);
    
                        const progress = ((uploadedChunks.size / chunks.length) * 100).toFixed(2);
                        const { speed, eta } = this.calculateSpeedAndETA(
                            uploadedBytes,
                            file.size,
                            startTime
                        );
    
                        this.emit('fileProgress', {
                            fileName: file.name,
                            progress,
                            speed,
                            eta,
                        });
    
                        if (this.adaptiveConcurrency) {
                            this.adjustConcurrency(speed);
                        }
                    })
                    .catch((error) => {
                        this.logError(`Chunk upload failed for file: ${file.name}, chunk: ${i}, range: ${startRange}-${endRange}`, error);
                        throw error;
                    });

                uploadPool.push(chunkUploadPromise);
            }
    
            // Wait for all remaining uploads to finish
            await Promise.all(uploadPool);
    
            // Finalize upload if using Block Blob
            if (this.storageType === 'blob') {
                await this.finalizeBlobUpload(client, chunks.length);
            }
    
            this.emit('fileComplete', { fileName: file.name });
            this.logInfo(`Upload completed for ${file.name}`);
            this.progressStore.removeItem(`uploader_progress_${file.name}`);
            delete this.resumeData[file.name];
        } catch (error) {
            this.logError(`Upload failed for ${file.name}.`, error);
            await this.cleanupFile(file.name, destinationPath);
            throw error;
        }
    }
    
    async uploadChunk(client, chunk, index, startRange, endRange) {
        // const { startRange, endRange, actualChunkSize } = calculateChunkRange(fileSize, chunk.size, index);

        if (this.storageType === 'file') {
            this.logInfo(`Uploading chunk ${index}: range=${startRange}-${endRange}, size=${chunk.size}`);
            await client.uploadRange(chunk, startRange, chunk.size, {
                headers: {
                    'x-ms-range': `bytes=${startRange}-${endRange}`,
                    'Content-Length': chunk.size,
                },
            });
        } else if (this.storageType === 'blob') {
            const blockId = btoa(String(index).padStart(6, '0'));
            await client.stageBlock(blockId, chunk, chunk.size);
        }
    }

    async finalizeBlobUpload(client, totalChunks) {
        const blockIds = Array.from({ length: totalChunks }, (_, i) =>
            btoa(String(i).padStart(6, '0'))
        );
        await client.commitBlockList(blockIds);
    }

    initializeClient(storageUrl) {
        if (this.storageType === 'file') {
            return new ShareFileClient(storageUrl);
        } else if (this.storageType === 'blob') {
            return new BlockBlobClient(storageUrl);
        } else {
            throw new Error("Invalid storage type. Must be 'blob' or 'file'.");
        }
    }

    async pauseUpload(fileName) {
        if (!this.resumeData[fileName]) {
            this.logInfo(`No active upload found for ${fileName}.`);
            return;
        }
        this.pausedFiles.add(fileName);
        this.logInfo(`Paused upload for ${fileName}.`);
    }

    async resumeUpload(fileName) {
        if (!this.resumeData[fileName]) {
            this.logInfo(`No paused upload found for ${fileName}.`);
            return;
        }
        this.pausedFiles.delete(fileName);
        const { file } = this.resumeData[fileName];
        this.logInfo(`Resuming upload for ${fileName}.`);
        await this.uploadFile(file);
    }

    adjustConcurrency(speed) {
        const maxConcurrency = this.defaultConcurrency * 2; // Double the default as the maximum
        const minConcurrency = 2; // Minimum concurrency floor
        const recoveryInterval = 15 * 1000; // Wait 15 seconds before attempting increases
        const speedThresholdIncrease = 15; // Minimum speed (MB/s) to increase concurrency
        const speedThresholdDecrease = 2; // Speed below which to decrease concurrency
        const idealSpeedPerConnection = 5; // Ideal speed per connection in MB/s

        // Adjust concurrency based on speed
        if (speed / this.currentConcurrency < speedThresholdDecrease && this.currentConcurrency > minConcurrency) {
            this.currentConcurrency = Math.max(this.currentConcurrency - 1, minConcurrency);
            this.logInfo(`Reduced concurrency to ${this.currentConcurrency}`);
        } else if (speed / this.currentConcurrency > idealSpeedPerConnection && speed > speedThresholdIncrease && this.currentConcurrency < maxConcurrency) {
            this.currentConcurrency++;
            this.logInfo(`Increased concurrency to ${this.currentConcurrency}`);
        }

        // Recovery timer: Periodically test higher concurrency even if speed is low
        if (!this.recoveryTimer) {
            this.recoveryTimer = setTimeout(() => {
                if (this.currentConcurrency < maxConcurrency) {
                    this.currentConcurrency++;
                    this.logInfo(`Testing increased concurrency: ${this.currentConcurrency}`);
                }
                this.recoveryTimer = null; // Reset the timer
            }, recoveryInterval);
        }
    }

    destroy() {
        // Remove all event listeners
        this.removeAllListeners();
    
        // Clear any ongoing timers or intervals
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    
        // Clear in-progress uploads
        Object.keys(this.resumeData).forEach((fileName) => {
            this.cancelledFiles.add(fileName);
            this.logInfo(`Cancelled upload for ${fileName} during destroy.`);
        });
    
        // Clear other resources
        this.resumeData = {};
        this.pausedFiles.clear();
        this.cancelledFiles.clear();
    
        this.logInfo("Uploader instance destroyed.");
    }
    

}
