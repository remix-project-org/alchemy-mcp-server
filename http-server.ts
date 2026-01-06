#!/usr/bin/env node

import { spawn, ChildProcess } from 'child_process';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 9000;

app.use(cors());
app.use(express.json());

let mcpProcess: ChildProcess | null = null;
let isProcessReady = false;
const requestQueue: Array<{ id: string; request: any; resolve: (value: any) => void; reject: (reason?: any) => void }> = [];
const pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (reason?: any) => void }>();

function startMcpProcess() {
    const mcpServerPath = path.join(__dirname, 'index.js');

    console.log('[Alchemy HTTP Bridge] Starting MCP server:', mcpServerPath);

    mcpProcess = spawn('node', [mcpServerPath], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    mcpProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter((line: string) => line.trim());

        lines.forEach((line: string) => {
            try {
                const response = JSON.parse(line);

                // Handle initialization response
                if (response.result && !response.id) {
                    console.log('[Alchemy HTTP Bridge] MCP server initialized');
                    isProcessReady = true;
                    processQueue();
                    return;
                }

                // Handle regular responses
                if (response.id) {
                    const pending = pendingRequests.get(response.id);
                    if (pending) {
                        pending.resolve(response);
                        pendingRequests.delete(response.id);
                    }
                }
            } catch (e) {
                // Not JSON, probably a log message
                console.log('[Alchemy MCP Server]', line);
            }
        });
    });

    mcpProcess.stderr?.on('data', (data) => {
        const message = data.toString();
        // Check if it's the "running on stdio" message which indicates readiness
        if (message.includes('running on stdio')) {
            console.log('[Alchemy HTTP Bridge] MCP server ready');
            isProcessReady = true;
            processQueue();
        } else {
            console.error('[Alchemy MCP Server Error]', message);
        }
    });

    mcpProcess.on('exit', (code) => {
        console.error('[Alchemy HTTP Bridge] MCP server exited with code:', code);
        isProcessReady = false;
        // Restart the process
        setTimeout(() => {
            console.log('[Alchemy HTTP Bridge] Restarting MCP server...');
            startMcpProcess();
        }, 2000);
    });

    mcpProcess.on('error', (err) => {
        console.error('[Alchemy HTTP Bridge] Failed to start MCP server:', err);
    });

    // Send initialization message
    if (mcpProcess.stdin) {
        const initMessage = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'alchemy-http-bridge',
                    version: '1.0.0'
                }
            },
            id: 'init'
        };
        mcpProcess.stdin.write(JSON.stringify(initMessage) + '\n');
    }
}

function processQueue() {
    while (requestQueue.length > 0 && isProcessReady) {
        const item = requestQueue.shift();
        if (item) {
            sendToMcp(item.request, item.resolve, item.reject);
        }
    }
}

function sendToMcp(request: any, resolve: (value: any) => void, reject: (reason?: any) => void) {
    if (!mcpProcess || !mcpProcess.stdin) {
        reject(new Error('MCP server is not running'));
        return;
    }

    const requestId = request.id || `req_${Date.now()}_${Math.random()}`;
    const mcpRequest = { ...request, id: requestId };

    pendingRequests.set(requestId, { resolve, reject });

    try {
        mcpProcess.stdin.write(JSON.stringify(mcpRequest) + '\n');

        // Set timeout for request
        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                reject(new Error('Request timeout'));
            }
        }, 30000); // 30 second timeout
    } catch (error) {
        pendingRequests.delete(requestId);
        reject(error);
    }
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        mcpServerReady: isProcessReady
    });
});

// Main MCP proxy endpoint
app.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const request = req.body;

        // Validate JSON-RPC request
        if (!request.jsonrpc || request.jsonrpc !== '2.0') {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32600,
                    message: 'Invalid Request: jsonrpc must be "2.0"'
                },
                id: request.id || null
            });
            return;
        }

        if (!request.method) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32600,
                    message: 'Invalid Request: method is required'
                },
                id: request.id || null
            });
            return;
        }

        // Queue or process request
        const responsePromise = new Promise((resolve, reject) => {
            if (isProcessReady) {
                sendToMcp(request, resolve, reject);
            } else {
                requestQueue.push({ id: request.id, request, resolve, reject });
            }
        });

        const response = await responsePromise;
        res.json(response);

    } catch (error: any) {
        console.error('[Alchemy HTTP Bridge] Error processing request:', error);
        res.status(500).json({
            jsonrpc: '2.0',
            error: {
                code: -32603,
                message: error.message || 'Internal error'
            },
            id: req.body.id || null
        });
    }
});

// Start the MCP server process
startMcpProcess();

// Start HTTP server
app.listen(PORT, () => {
    console.log(`[Alchemy HTTP Bridge] Server listening on port ${PORT}`);
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('[Alchemy HTTP Bridge] Shutting down...');
    if (mcpProcess) {
        mcpProcess.kill();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Alchemy HTTP Bridge] Shutting down...');
    if (mcpProcess) {
        mcpProcess.kill();
    }
    process.exit(0);
});