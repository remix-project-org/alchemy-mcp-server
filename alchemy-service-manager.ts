import { spawn, ChildProcess } from 'child_process';
import path from 'path';

class AlchemyServiceManager {
    private process: ChildProcess | null = null;
    private restartAttempts = 0;
    private maxRestartAttempts = 5;
    private restartDelay = 2000;

    start() {
        if (this.process) {
            console.log('[Alchemy Service Manager] Service already running');
            return;
        }

        console.log('[Alchemy Service Manager] Starting Alchemy HTTP bridge server...');

        this.process = spawn('node', ['./dist/http-server.js'], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });

        this.process.stdout?.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                console.log(`[Alchemy Service] ${message}`);
            }
        });

        this.process.stderr?.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                console.error(`[Alchemy Service Error] ${message}`);
            }
        });

        this.process.on('exit', (code, signal) => {
            console.log(`[Alchemy Service Manager] Process exited with code ${code} and signal ${signal}`);
            this.process = null;

            // Auto-restart logic with exponential backoff
            if (this.restartAttempts < this.maxRestartAttempts) {
                this.restartAttempts++;
                const delay = this.restartDelay * this.restartAttempts;
                console.log(`[Alchemy Service Manager] Scheduling restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);

                setTimeout(() => {
                    console.log(`[Alchemy Service Manager] Attempting to restart...`);
                    this.start();
                }, delay);
            } else {
                console.error(`[Alchemy Service Manager] Max restart attempts (${this.maxRestartAttempts}) reached. Service will not auto-restart.`);
            }
        });

        this.process.on('error', (err) => {
            console.error('[Alchemy Service Manager] Failed to start process:', err);
            this.process = null;
        });

        setTimeout(() => {
            if (this.process) {
                this.restartAttempts = 0;
                console.log('[Alchemy Service Manager] Service running successfully');
            }
        }, 5000);
    }

    stop() {
        if (this.process) {
            console.log('[Alchemy Service Manager] Stopping service...');
            this.process.kill('SIGTERM');
            this.process = null;
            this.restartAttempts = 0;
        }
    }

    isRunning(): boolean {
        return this.process !== null && !this.process.killed;
    }
}

const alchemyServiceManager = new AlchemyServiceManager()
alchemyServiceManager.start()