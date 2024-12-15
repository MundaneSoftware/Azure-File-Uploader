# File Uploader

A robust library for uploading large files to Cloud Storage with:
- Chunked uploads
- Retry mechanism with exponential backoff
- Resumable uploads
- Dynamic concurrency adjustment based on network conditions
- Custom logging support

## Installation

```bash
npm install @mundanesoftware/file-uploader
```

## Initialisation

You can configure the Uploader with the following options:

- maxConcurrentUploads: The maximum number of concurrent chunk uploads.
- destinationResolver: A function that resolves the destination URL for each file.
- refreshSasToken: A function that returns a refreshed SAS token for secure uploads.
- infoLogger: (Optional) Custom function to handle info logs.
- errorLogger: (Optional) Custom function to handle error logs.

## Basic Example

```javascript
import Uploader from 'file-uploader';

// Initialize the uploader
const uploader = new Uploader({
    maxConcurrentUploads: 5,
    destinationResolver: async (file) => {
        const datasetName = file.dataset || 'default-dataset';
        return `https://myaccount.blob.core.windows.net/${datasetName}`;
    },
    refreshSasToken: async (fileName) => {
        const response = await fetch(`/api/refresh-sas?file=${fileName}`);
        const data = await response.json();
        return data.sasToken;
    },
    infoLogger: console.info,
    errorLogger: console.error,
});

// Handle files
const files = [
    { name: 'file1.txt', dataset: 'dataset1', size: 1024 },
    { name: 'file2.txt', dataset: 'dataset2', size: 2048 },
];

// Start the upload process
uploader.uploadFiles(files)
    .then(() => console.log('All files uploaded successfully!'))
    .catch((err) => console.error('Error uploading files:', err));
```

## Resumable Upload Example

The uploader supports resumable uploads for both network interruptions and user-initiated pauses.

```javascript
// Pause a file upload
uploader.pauseUpload('file1.txt');

// Resume the paused file upload
uploader.resumeUpload({ name: 'file1.txt', dataset: 'dataset1', size: 1024 });
```

## Event Listeners

You can listen to the following events emitted by the Uploader:

- fileStart: Fired when a file starts uploading.
- fileProgress: Fired periodically to indicate the upload progress of a file.
- fileComplete: Fired when a file finishes uploading.
- chunkProgress: Fired for individual chunk upload progress.
- error: Fired when an error occurs.

```javascript
uploader.on('fileStart', (data) => console.log(`Starting upload for ${data.fileName}`));
uploader.on('fileProgress', (data) => console.log(`${data.fileName} is ${data.progress}% complete`));
uploader.on('fileComplete', (data) => console.log(`${data.fileName} completed successfully`));
uploader.on('error', (error) => console.error('Upload error:', error));
```

## Dynamic Concurrency Adjustment

The uploader automatically adjusts concurrency based on the user's network conditions.

- Fast Network (4G and above): Increases concurrency for faster uploads.
- Slow Network (3G, 2G): Reduces concurrency to prevent overload.
- No Network Information: Defaults to maxConcurrentUploads.

## Logging

You can provide custom logging functions to integrate with external logging systems like Sentry.

```javascript
const infoLogger = (message, data) => {
    // Custom log handling
    console.log(`[INFO]: ${message}`, data);
};

const errorLogger = (message, error) => {
    // Custom error handling
    console.error(`[ERROR]: ${message}`, error);
};

const uploader = new Uploader({
    maxConcurrentUploads: 3,
    destinationResolver: async (file) => `https://myaccount.blob.core.windows.net/${file.dataset}`,
    refreshSasToken: async (fileName) => 'YOUR_SAS_TOKEN',
    infoLogger,
    errorLogger,
});
```

## Advanced Retry Mechanism

The uploader retries failed chunk uploads with exponential backoff:

- Max Retries: 3 (default, configurable).
- Backoff Delay: Starts at 500ms and doubles with each attempt.

```javascript
async uploadChunk(chunk, uploadUrl, index, maxRetries = 3, delay = 500) {
    const config = {
        headers: {
            'x-ms-blob-type': 'BlockBlob',
        },
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await axios.put(uploadUrl, chunk, config);
            return; // Exit on success
        } catch (error) {
            if (attempt === maxRetries) {
                throw error; // Throw error after max retries
            }

            const backoff = delay * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, backoff));
        }
    }
}

```