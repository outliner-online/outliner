#!/usr/bin/env node

/**
 * Production Environment Check Script
 *
 * Usage:
 * node scripts/check-production-environment.js
 *
 * This script checks if the current environment is a production environment.
 */

const https = require("https");

// Colored log output
const colors = {
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    blue: "\x1b[34m",
    reset: "\x1b[0m",
};

function log(message, color = "reset") {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// Production environment health check
function checkProductionHealth() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: "outliner-online.com",
            path: "/api/health",
            method: "GET",
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            let responseData = "";

            res.on("data", (chunk) => {
                responseData += chunk;
            });

            res.on("end", () => {
                try {
                    const parsedData = JSON.parse(responseData);
                    resolve({ statusCode: res.statusCode, data: parsedData });
                } catch (error) {
                    resolve({ statusCode: res.statusCode, data: responseData });
                }
            });
        });

        req.on("error", (error) => {
            reject(error);
        });

        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });

        req.end();
    });
}

// Check Firebase project information
function checkFirebaseProject() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: "outliner-online.com",
            path: "/",
            method: "GET",
            timeout: 10000,
        };

        const req = https.request(options, (res) => {
            resolve({ statusCode: res.statusCode, headers: res.headers });
        });

        req.on("error", (error) => {
            reject(error);
        });

        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });

        req.end();
    });
}

// Check environment variables
function checkEnvironmentVariables() {
    const requiredEnvVars = [
        "NODE_ENV",
        "FIREBASE_PROJECT_ID",
    ];

    const envStatus = {};

    requiredEnvVars.forEach(varName => {
        envStatus[varName] = {
            exists: !!process.env[varName],
            value: process.env[varName] || "undefined",
        };
    });

    return envStatus;
}

// Detect emulator environment
function detectEmulatorEnvironment() {
    const emulatorVars = [
        "FUNCTIONS_EMULATOR",
        "FIRESTORE_EMULATOR_HOST",
        "FIREBASE_AUTH_EMULATOR_HOST",
        "FIREBASE_STORAGE_EMULATOR_HOST",
    ];

    const emulatorStatus = {};
    let hasEmulator = false;

    emulatorVars.forEach(varName => {
        const exists = !!process.env[varName];
        emulatorStatus[varName] = {
            exists,
            value: process.env[varName] || "undefined",
        };
        if (exists) hasEmulator = true;
    });

    return { hasEmulator, emulatorStatus };
}

// Main process
async function main() {
    log("=".repeat(60), "blue");
    log("Production Environment Check Script", "blue");
    log("=".repeat(60), "blue");
    log("");

    // Check environment variables
    log("🔍 Environment Variable Check:", "blue");
    const envVars = checkEnvironmentVariables();

    Object.entries(envVars).forEach(([key, info]) => {
        const status = info.exists ? "✅" : "❌";
        const color = info.exists ? "green" : "red";
        log(`  ${status} ${key}: ${info.value}`, color);
    });
    log("");

    // Detect emulator environment
    log("🔍 Emulator Environment Check:", "blue");
    const emulatorInfo = detectEmulatorEnvironment();

    if (emulatorInfo.hasEmulator) {
        log("  ⚠️  Emulator environment detected", "yellow");
        Object.entries(emulatorInfo.emulatorStatus).forEach(([key, info]) => {
            if (info.exists) {
                log(`    - ${key}: ${info.value}`, "yellow");
            }
        });
    } else {
        log("  ✅ Emulator environment not detected", "green");
    }
    log("");

    // Determine production environment
    const isProduction = process.env.NODE_ENV === "production" && !emulatorInfo.hasEmulator;
    log("🎯 Environment Determination:", "blue");
    log(`  Current Environment: ${isProduction ? "Production" : "Development/Test"}`, isProduction ? "red" : "green");
    log("");

    // Additional checks if production environment
    if (isProduction) {
        log("🌐 Production Connection Check:", "blue");

        try {
            // Firebase Functions Health Check
            log("  Checking Firebase Functions...", "yellow");
            const healthResponse = await checkProductionHealth();

            if (healthResponse.statusCode === 200) {
                log("  ✅ Firebase Functions: Normal", "green");
                if (healthResponse.data && healthResponse.data.status) {
                    log(`    - Status: ${healthResponse.data.status}`, "blue");
                    log(`    - Timestamp: ${healthResponse.data.timestamp}`, "blue");
                }
            } else {
                log(`  ❌ Firebase Functions: Error (HTTP ${healthResponse.statusCode})`, "red");
            }
        } catch (error) {
            log(`  ❌ Firebase Functions: Connection Error - ${error.message}`, "red");
        }

        try {
            // Firebase Hosting Check
            log("  Checking Firebase Hosting...", "yellow");
            const hostingResponse = await checkFirebaseProject();

            if (hostingResponse.statusCode === 200) {
                log("  ✅ Firebase Hosting: Normal", "green");
            } else {
                log(`  ❌ Firebase Hosting: Error (HTTP ${hostingResponse.statusCode})`, "red");
            }
        } catch (error) {
            log(`  ❌ Firebase Hosting: Connection Error - ${error.message}`, "red");
        }

        log("");
        log("⚠️  WARNING: Production environment detected", "red");
        log("   Be sure to backup before performing data deletion operations.", "red");
        log("   Backup command: node scripts/backup-production-data.js", "yellow");
    } else {
        log("ℹ️  Currently in Development/Test Environment", "blue");
        log("   Data deletion operations in production environment will not be executed.", "blue");
    }

    log("");
    log("Check completed", "green");

    // Exit code (1 for production, 0 otherwise)
    process.exit(isProduction ? 1 : 0);
}

// Execute script
if (require.main === module) {
    main().catch(error => {
        log(`❌ Unexpected error: ${error.message}`, "red");
        process.exit(1);
    });
}

module.exports = { main, checkProductionHealth, detectEmulatorEnvironment };
