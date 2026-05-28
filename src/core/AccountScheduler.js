/**
 * File: src/core/AccountScheduler.js
 * Description: Coordinates multiple Google accounts, handles request queues, RPM throttling, 
 * cooling down accounts on 429 errors, and balancing requests.
 *
 * Author: Antigravity
 */

const { EventEmitter } = require("events");

class AccountScheduler extends EventEmitter {
    constructor(logger, config, authSource, browserManager = null) {
        super();
        this.logger = logger;
        this.config = config;
        this.authSource = authSource;
        this.browserManager = browserManager;

        // Configuration values
        this.singleConcurrencyLimit = parseInt(config.singleAccountConcurrency || "3", 10);
        this.coolDownDuration = parseInt(config.accountCoolDownMs || "300000", 10); // Default 5 minutes
        this.queueTimeout = parseInt(config.globalQueueTimeoutMs || "30000", 10); // Default 30 seconds

        // Scheduler state
        this.accountStates = new Map(); // authIndex -> { activeRequests: 0, status: 'IDLE'|'COOL_DOWN'|'ERROR', coolDownUntil: 0 }
        this.waitingQueue = []; // FIFO Queue of { resolve, reject, timer, timestamp }

        this.logger.info(`[Scheduler] Initialized: singleConcurrency=${this.singleConcurrencyLimit}, coolDown=${this.coolDownDuration}ms, queueTimeout=${this.queueTimeout}ms`);
    }

    /**
     * Set context status.
     * @param {number} authIndex 
     * @param {'IDLE'|'COOL_DOWN'|'ERROR'} status 
     */
    setAccountStatus(authIndex, status) {
        const state = this._getOrCreateState(authIndex);
        const oldStatus = state.status;
        state.status = status;
        
        if (status === "COOL_DOWN") {
            state.coolDownUntil = Date.now() + this.coolDownDuration;
            this.logger.warn(`[Scheduler] Account #${authIndex} marked as COOL_DOWN until ${new Date(state.coolDownUntil).toISOString()}`);
            
            // Set timer to recover account
            setTimeout(() => {
                const currentState = this.accountStates.get(authIndex);
                if (currentState && currentState.status === "COOL_DOWN" && Date.now() >= currentState.coolDownUntil) {
                    currentState.status = "IDLE";
                    this.logger.info(`[Scheduler] Account #${authIndex} recovered from COOL_DOWN. Back to IDLE.`);
                    this.checkQueue();
                }
            }, this.coolDownDuration);
        } else if (status === "ERROR") {
            this.logger.error(`[Scheduler] Account #${authIndex} marked as ERROR`);
        } else if (status === "IDLE" && oldStatus !== "IDLE") {
            this.logger.info(`[Scheduler] Account #${authIndex} marked as IDLE`);
        }
    }

    /**
     * Request an account context to process request.
     * Returns a Promise resolving to the allocated authIndex.
     */
    acquireAccount() {
        return new Promise((resolve, reject) => {
            // Find an immediately available account
            const allocatedIndex = this._findAvailableAccount();
            if (allocatedIndex !== null) {
                const state = this.accountStates.get(allocatedIndex);
                state.activeRequests++;
                this.logger.info(`[Scheduler] Allocated Account #${allocatedIndex} (Active requests: ${state.activeRequests}/${this.singleConcurrencyLimit})`);
                return resolve(allocatedIndex);
            }

            // Put in waiting FIFO queue
            this.logger.info(`[Scheduler] All accounts busy. Request queued (Queue size: ${this.waitingQueue.length + 1})`);
            
            const queueItem = { resolve, reject, timestamp: Date.now() };
            
            // Set timeout
            queueItem.timer = setTimeout(() => {
                const idx = this.waitingQueue.indexOf(queueItem);
                if (idx !== -1) {
                    this.waitingQueue.splice(idx, 1);
                    this.logger.warn(`[Scheduler] Request timed out in queue after ${this.queueTimeout}ms`);
                    reject(new Error("Queue timeout: Server is busy, please try again later."));
                }
            }, this.queueTimeout);

            this.waitingQueue.push(queueItem);
        });
    }

    /**
     * Release an account when request completes or fails.
     * @param {number} authIndex 
     * @param {number|null} statusCode - The status code returned (e.g. 429, 200)
     */
    releaseAccount(authIndex, statusCode = null) {
        const state = this.accountStates.get(authIndex);
        if (!state) return;

        state.activeRequests = Math.max(0, state.activeRequests - 1);
        this.logger.info(`[Scheduler] Released Account #${authIndex} (Active requests: ${state.activeRequests}/${this.singleConcurrencyLimit})`);

        if (statusCode === 429) {
            this.setAccountStatus(authIndex, "COOL_DOWN");
        }

        // Process queue next tick
        process.nextTick(() => this.checkQueue());
    }

    /**
     * Process pending items in queue.
     */
    checkQueue() {
        if (this.waitingQueue.length === 0) return;

        const allocatedIndex = this._findAvailableAccount();
        if (allocatedIndex === null) return; // Still no account available

        const queueItem = this.waitingQueue.shift();
        if (queueItem) {
            clearTimeout(queueItem.timer);
            const state = this.accountStates.get(allocatedIndex);
            state.activeRequests++;
            this.logger.info(`[Scheduler] Dequeued request, allocated Account #${allocatedIndex} (Active requests: ${state.activeRequests}/${this.singleConcurrencyLimit})`);
            queueItem.resolve(allocatedIndex);
        }
    }

    /**
     * Check if a specific account is available.
     */
    isAccountAvailable(authIndex) {
        const state = this.accountStates.get(authIndex);
        if (!state) return false;
        return state.status === "IDLE" && state.activeRequests < this.singleConcurrencyLimit;
    }

    _findAvailableAccount() {
        const indices = this.authSource.availableIndices;
        let bestIndex = null;
        let minActive = Infinity;

        for (const idx of indices) {
            // Only route to accounts that are currently active and loaded contexts in the pool
            if (this.browserManager) {
                const isLoaded = this.browserManager.contexts.has(idx);
                if (!isLoaded) {
                    continue;
                }
            }

            const state = this._getOrCreateState(idx);
            
            // Check cooling down
            if (state.status === "COOL_DOWN") {
                if (Date.now() >= state.coolDownUntil) {
                    state.status = "IDLE";
                } else {
                    continue;
                }
            }

            if (state.status === "IDLE" && state.activeRequests < this.singleConcurrencyLimit) {
                if (state.activeRequests < minActive) {
                    minActive = state.activeRequests;
                    bestIndex = idx;
                }
            }
        }

        return bestIndex;
    }

    _getOrCreateState(authIndex) {
        if (!this.accountStates.has(authIndex)) {
            this.accountStates.set(authIndex, {
                activeRequests: 0,
                status: "IDLE",
                coolDownUntil: 0
            });
        }
        return this.accountStates.get(authIndex);
    }
}

module.exports = AccountScheduler;
