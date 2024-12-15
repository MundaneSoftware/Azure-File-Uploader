/**
 * @typedef {Object} UploaderConfig
 * @property {number} maxConcurrentUploads - Max uploads at the same time.
 * @property {Function} destinationResolver - Function to resolve file destination.
 * @property {Function} refreshSasToken - Function to refresh SAS tokens.
 * @property {Function} [infoLogger] - Custom logger for informational messages.
 * @property {Function} [errorLogger] - Custom logger for errors.
 */
