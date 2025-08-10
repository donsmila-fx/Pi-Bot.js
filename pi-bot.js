const stellar = require('stellar-sdk');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const ntpClient = require('ntp-client');

const HORIZON_URL = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const THREADS_PER_BATCH = parseInt(process.env.THREADS_PER_BATCH || '5', 10);
const BATCH_INTERVAL = parseInt(process.env.BATCH_INTERVAL || '2000', 10);
const fireBefore = parseInt(process.env.FIRE_BEFORE || '1200', 10); // ms before unlock time

let seqNum = null; // local sequence cache

// Load settings from environment variables
const mnemonic = process.env.MNEMONIC;
const destination = process.env.DESTINATION;
const inputAmount = process.env.AMOUNT;
const feeInput = process.env.FEE;
const unlockTimeInput = process.env.UNLOCK_TIME; // HH:MM:SS UTC

if (!mnemonic || !destination || !inputAmount || !feeInput || !unlockTimeInput) {
    console.error('❌ Missing required environment variables.');
    process.exit(1);
}

// Small helper
function wait(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// Sync exact time from NTP
async function getExactTime() {
    return new Promise(resolve => {
        ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
            if (err) resolve(new Date());
            else resolve(date);
        });
    });
}

(async () => {
    if (!bip39.validateMnemonic(mnemonic)) {
        console.error('❌ Invalid mnemonic.');
        process.exit(1);
    }

    // Derive keypair
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derived = edHd.derivePath("m/44'/314159'/0'", seed);
    const keypair = stellar.Keypair.fromRawEd25519Seed(derived.key);
    const publicKey = keypair.publicKey();
    const server = new stellar.Horizon.Server(HORIZON_URL);

    // Parse unlock time
    const unlockParts = unlockTimeInput.split(':').map(Number);
    const now = await getExactTime();
    const unlockTime = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        unlockParts[0],
        unlockParts[1],
        unlockParts[2]
    ));

    console.log(`📅 Scheduled unlock at: ${unlockTime.toISOString()}`);

    // Preload account sequence
    const account = await server.loadAccount(publicKey);
    seqNum = BigInt(account.sequenceNumber());

    // Wait until firing moment
    while (Date.now() < unlockTime - fireBefore) {
        const remaining = ((unlockTime - fireBefore - Date.now()) / 1000).toFixed(2);
        process.stdout.write(`⏳ Waiting... ${remaining}s\r`);
        await wait(100);
    }

    console.log(`\n🚀 Firing transactions with ${THREADS_PER_BATCH} threads every ${BATCH_INTERVAL / 1000}s...`);

    async function fireThread(threadId) {
        try {
            let localSeq = (seqNum++).toString();

            const txBuilder = new stellar.TransactionBuilder(
                new stellar.Account(publicKey, localSeq),
                { fee: Math.floor(parseFloat(feeInput) * 1e7).toString(), networkPassphrase: NETWORK_PASSPHRASE }
            );

            // Claim if available
            const claimable = await server.claimableBalances().claimant(publicKey).order('desc').limit(1).call();
            if (claimable.records[0]) {
                txBuilder.addOperation(stellar.Operation.claimClaimableBalance({
                    balanceId: claimable.records[0].id
                }));
                console.log(`[Thread ${threadId}] 📦 Claiming: ${claimable.records[0].id}`);
            }

            // Payment
            txBuilder.addOperation(stellar.Operation.payment({
                destination,
                asset: stellar.Asset.native(),
                amount: parseFloat(inputAmount).toFixed(7)
            }));

            const tx = txBuilder.setTimeout(30).build();
            tx.sign(keypair);

            const result = await server.submitTransaction(tx);
            console.log(`[Thread ${threadId}] ✅ Success: ${result.hash}`);

        } catch (err) {
            const code = err.response?.data?.extras?.result_codes?.transaction;
            if (code === 'tx_bad_seq') {
                console.warn(`[Thread ${threadId}] ⚠️ Bad sequence, adjusting...`);
                seqNum++;
            } else if (err.response?.status === 429) {
                console.warn(`[Thread ${threadId}] ⛔ Rate limit`);
            } else {
                console.error(`[Thread ${threadId}] ❌ Error:`, err.response?.data || err.message);
            }
        }
    }

    // Batch spamming loop
    setInterval(() => {
        console.log(`\n🧵 New batch firing...`);
        for (let i = 1; i <= THREADS_PER_BATCH; i++) {
            fireThread(i);
        }
    }, BATCH_INTERVAL);
})();
