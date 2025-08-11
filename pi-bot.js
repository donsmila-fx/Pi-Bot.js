// index.js — corrected version
// Environment-driven, headless Pi spam/withdraw bot
// Expects: MNEMONIC, DESTINATION, AMOUNT, FEE, UNLOCK_TIME (HH:MM:SS UTC)
// Optional: THREADS_PER_BATCH, BATCH_INTERVAL, FIRE_BEFORE

const stellar = require('stellar-sdk');
const { Server, Keypair, TransactionBuilder, Account, Operation, Asset } = stellar;
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const ntpClient = require('ntp-client'); // keep if you have it installed

const HORIZON_URL = process.env.HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || 'Pi Network';

const THREADS_PER_BATCH = parseInt(process.env.THREADS_PER_BATCH || '5', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '2000', 10);
const fireBefore = parseInt(process.env.FIRE_BEFORE || '1200', 10); // ms before unlock time
const SECONDS_POLL = 0.1;

let seqNum = null; // local BigInt sequence cache

// Load settings from environment variables
const mnemonic = process.env.MNEMONIC;
const destination = process.env.DESTINATION;
const inputAmount = process.env.AMOUNT;
const feeInput = process.env.FEE;
const unlockTimeInput = process.env.UNLOCK_TIME; // HH:MM:SS UTC

if (!mnemonic || !destination || !inputAmount || !feeInput || !unlockTimeInput) {
    console.error('❌ Missing required environment variables. Required: MNEMONIC, DESTINATION, AMOUNT, FEE, UNLOCK_TIME');
    process.exit(1);
}

function wait(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// Try NTP, fallback to local Date()
async function getExactTime() {
    return new Promise(resolve => {
        try {
            ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
                if (err) {
                    // fallback
                    resolve(new Date());
                } else {
                    resolve(date);
                }
            });
        } catch (e) {
            resolve(new Date());
        }
    });
}

(async () => {
    // validate mnemonic
    if (!bip39.validateMnemonic(mnemonic)) {
        console.error('❌ Invalid mnemonic.');
        process.exit(1);
    }

    // derive keypair
    const seed = await bip39.mnemonicToSeed(mnemonic); // Buffer
    const derived = edHd.derivePath("m/44'/314159'/0'", seed);
    const keypair = Keypair.fromRawEd25519Seed(derived.key);
    const publicKey = keypair.publicKey();

    const server = new Server(HORIZON_URL);

    // parse unlock time HH:MM:SS (UTC)
    const unlockParts = unlockTimeInput.split(':').map(Number);
    if (unlockParts.length !== 3 || unlockParts.some(isNaN)) {
        console.error('❌ UNLOCK_TIME must be in HH:MM:SS format (UTC).');
        process.exit(1);
    }

    const now = await getExactTime();
    const unlockTime = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        unlockParts[0],
        unlockParts[1],
        unlockParts[2]
    ));

    console.log(`📅 Scheduled unlock at: ${unlockTime.toISOString()} (based on NTP fallback)`);

    // fetch account sequence
    try {
        const account = await server.loadAccount(publicKey);
        seqNum = BigInt(account.sequenceNumber());
        console.log(`🔢 Loaded account sequence: ${seqNum.toString()}`);
    } catch (err) {
        console.error('❌ Failed to load account from Horizon:', err.message || err);
        process.exit(1);
    }

    // Wait until firing moment (fireBefore ms early)
    while (Date.now() < unlockTime.getTime() - fireBefore) {
        const remaining = ((unlockTime.getTime() - fireBefore - Date.now()) / 1000).toFixed(2);
        process.stdout.write(`⏳ Waiting... ${remaining}s\r`);
        await wait(100);
    }

    console.log(`\n🚀 Firing transactions with ${THREADS_PER_BATCH} threads every ${BATCH_INTERVAL}ms...`);

    const feeStroops = (() => {
        // Convert feeInput (Pi) to stroops-like units used by your network conversion (original used 1e7)
        // Keep the same conversion factor you used previously
        const f = parseFloat(feeInput);
        if (isNaN(f)) return String(stellar.BASE_FEE); // default
        // keep original scaling: 1 Pi -> 10^7 units (as in your prior code)
        return Math.floor(f * 1e7).toString();
    })();

    async function fireThread(threadId) {
        try {
            // take local seq and increment global seq
            const localSeq = (seqNum++).toString();

            const txBuilder = new TransactionBuilder(
                new Account(publicKey, localSeq),
                { fee: feeStroops, networkPassphrase: NETWORK_PASSPHRASE }
            );

            // check claimable balances (take latest if exists)
            try {
                const claimable = await server.claimableBalances().claimant(publicKey).order('desc').limit(1).call();
                if (claimable.records && claimable.records.length > 0) {
                    txBuilder.addOperation(Operation.claimClaimableBalance({
                        balanceId: claimable.records[0].id
                    }));
                    console.log(`[Thread ${threadId}] 📦 Claiming: ${claimable.records[0].id}`);
                }
            } catch (cErr) {
                // If claim query fails, continue to build payment anyway
                console.warn(`[Thread ${threadId}] ⚠ Claimable check failed: ${cErr.message || cErr}`);
            }

            // add payment
            txBuilder.addOperation(Operation.payment({
                destination,
                asset: Asset.native(),
                amount: parseFloat(inputAmount).toFixed(7)
            }));

            const tx = txBuilder.setTimeout(30).build();
            tx.sign(keypair);

            const result = await server.submitTransaction(tx);
            console.log(`[Thread ${threadId}] ✅ Success: ${result.hash}`);
        } catch (err) {
            // try to read structured error
            const code = err?.response?.data?.extras?.result_codes?.transaction;
            if (code === 'tx_bad_seq') {
                console.warn(`[Thread ${threadId}] ⚠️ Bad sequence, incrementing seqNum...`);
                seqNum++;
            } else if (err?.response?.status === 429) {
                console.warn(`[Thread ${threadId}] ⛔ Rate limited by Horizon`);
            } else {
                console.error(`[Thread ${threadId}] ❌ Error:`, (err?.response?.data) ? err.response.data : (err.message || err));
            }
        }
    }

    // start batches
    setInterval(() => {
        console.log(`\n🧵 New batch firing...`);
        for (let i = 1; i <= THREADS_PER_BATCH; i++) {
            fireThread(i);
        }
    }, BATCH_INTERVAL);

})();
