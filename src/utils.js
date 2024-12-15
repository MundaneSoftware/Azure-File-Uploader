export const determineConcurrency = (defaultConcurrency) => {
    if (navigator.connection) {
        const { effectiveType, downlink } = navigator.connection;

        if (effectiveType === '4g' && downlink > 5) {
            return defaultConcurrency * 2;
        }
        if (effectiveType === '3g' || downlink <= 5) {
            return Math.max(1, Math.floor(defaultConcurrency / 2));
        }
        if (effectiveType === '2g') {
            return 1;
        }
    }

    return defaultConcurrency;
};

export const splitFileIntoChunks = (file, chunkSize) => {
    const chunks = [];
    let start = 0;

    while (start < file.size) {
        const end = Math.min(start + chunkSize, file.size); // Ensure the last chunk doesn't exceed file size
        chunks.push(file.slice(start, end));
        start = end;
    }

    // Verify chunking integrity
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    if (totalSize !== file.size) {
        throw new Error(`Chunking error: Total chunk size ${totalSize} does not match file size ${file.size}`);
    }

    return chunks;
};